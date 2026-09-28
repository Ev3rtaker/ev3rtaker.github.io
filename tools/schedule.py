#!/usr/bin/env python3
import getpass
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import requests

TZ = ZoneInfo("Europe/Moscow")
GITHUB_API = "https://api.github.com"
RELEASE_TAG = "current-movie"
MOVIE_FILENAME = "movie.mp4"
WORKER_URL = "https://raspy-cake-1c1a.qwgvpgy.workers.dev"
SHOW_URL = f"{WORKER_URL}/show.json"
UPDATE_URL = f"{WORKER_URL}/update-show"
USER_AGENT = "GitHub-Movie-Scheduler/6.0"

def load_env():
    path = Path(__file__).resolve().parent.parent / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)

def github_headers(token):
    return {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT}

def get_release(owner, repo, token):
    url = f"{GITHUB_API}/repos/{owner}/{repo}/releases/tags/{RELEASE_TAG}"
    r = requests.get(url, headers=github_headers(token), timeout=30)
    if r.status_code == 404:
        return None
    if not r.ok:
        raise RuntimeError(f"GitHub {r.status_code}: {r.text.strip() or r.reason}")
    return r.json()

def verify_movie(release):
    if not release:
        raise RuntimeError(f"Release {RELEASE_TAG} не найден. Сначала загрузите {MOVIE_FILENAME} вручную.")
    asset = next((x for x in release.get("assets", []) if x.get("name") == MOVIE_FILENAME), None)
    if not asset or asset.get("state") != "uploaded" or not asset.get("size"):
        raise RuntimeError(f"В Release {RELEASE_TAG} нет корректного {MOVIE_FILENAME}.")
    return asset

def worker_update(data, token):
    r = requests.post(UPDATE_URL, headers={"Authorization": f"Bearer {token}",
                       "Content-Type": "application/json"}, data=json.dumps(data, ensure_ascii=False),
                       timeout=30)
    if not r.ok:
        raise RuntimeError(f"Worker {r.status_code}: {r.text.strip() or r.reason}")
    return r.json()

def read_show():
    """
    Получить актуальное состояние показа.

    Query-параметр делает каждый запрос уникальным,
    а cache headers запрещают клиентскому HTTP-кэшу
    использовать старый ответ.
    """

    url = f"{SHOW_URL}?_={uuid.uuid4().hex}"

    headers = {
        "Cache-Control": (
            "no-cache, no-store, max-age=0, "
            "must-revalidate"
        ),
        "Pragma": "no-cache",
        "User-Agent": USER_AGENT,
    }

    r = requests.get(
        url,
        headers=headers,
        timeout=15,
    )

    if r.status_code == 404:
        return None

    if not r.ok:
        raise RuntimeError(
            f"Worker {r.status_code}: "
            f"{r.text.strip() or r.reason}"
        )

    try:
        return r.json()
    except ValueError as e:
        raise RuntimeError(
            f"Worker вернул некорректный JSON: {e}"
        )

def parse_time(value):
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    except ValueError:
        raise ValueError("Время должно быть в формате YYYY-MM-DD HH:MM")

def format_time(value):
    return value.astimezone(TZ).strftime("%Y-%m-%d %H:%M")

def format_duration(seconds):
    seconds = max(0, int(seconds or 0))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"

def show_id():
    return uuid.uuid4().hex

def paused_duration(data):
    total = 0.0
    for item in data.get("pauseIntervals", []):
        if not isinstance(item, dict):
            continue
        start, end = item.get("startUnix"), item.get("endUnix")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
            total += float(end) - float(start)
    return total

def position(data, now=None):
    now = datetime.now(timezone.utc).timestamp() if now is None else now
    start = data.get("startUnix")
    if not isinstance(start, (int, float)):
        try:
            start = datetime.fromisoformat(data["start"]).timestamp()
        except (KeyError, TypeError, ValueError):
            return 0.0
    start = float(start)
    if now < start:
        return 0.0
    if data.get("pause"):
        return max(0.0, float(data.get("pausePosition", 0) or 0))
    return max(0.0, now - start - paused_duration(data))

def ask_time(prompt, default=None):
    while True:
        suffix = f" [{format_time(default)}]" if default else ""
        value = input(f"{prompt}{suffix}: ").strip()
        if not value and default:
            return default
        try:
            return parse_time(value)
        except ValueError as e:
            print(f"Ошибка: {e}")

def config(repo):
    load_env()
    owner = os.getenv("GITHUB_OWNER", "Ev3rtaker")
    github_repo = os.getenv("GITHUB_REPO") or repo.name
    github_token = os.getenv("GITHUB_TOKEN")
    update_token = os.getenv("SHOW_UPDATE_TOKEN")
    if not github_token:
        github_token = getpass.getpass("GitHub Token: ").strip()
    if not github_token:
        raise RuntimeError("GITHUB_TOKEN не указан.")
    if not update_token:
        update_token = getpass.getpass("SHOW_UPDATE_TOKEN: ").strip()
    if not update_token:
        raise RuntimeError("SHOW_UPDATE_TOKEN не указан.")
    return owner, github_repo, github_token, update_token

def new_show(start, asset):
    return {"showId": show_id(), "start": start.isoformat(), "startUnix": start.timestamp(),
            "pause": False, "pauseUnix": None, "pausePosition": 0.0, "pausedDuration": 0.0,
            "pauseIntervals": [], "movie": MOVIE_FILENAME, "size": asset["size"],
            "mime": "video/mp4", "url": WORKER_URL}

def create_show(owner, github_repo, github_token, update_token):
    release = get_release(owner, github_repo, github_token)
    asset = verify_movie(release)
    start = ask_time("Время показа", datetime.now(TZ))
    data = new_show(start, asset)
    worker_update(data, update_token)
    print(f"✓ Показ создан: {format_time(start)}")

def change_time(update_token):
    data = read_show()
    if not data:
        print("Показ ещё не создан.")
        return
    old = datetime.fromisoformat(data["start"])
    new = ask_time("Новое время", old)
    data["showId"] = show_id()
    data["start"] = new.isoformat()
    data["startUnix"] = new.timestamp()
    data["pause"] = False
    data["pauseUnix"] = None
    data["pausePosition"] = 0.0
    data["pausedDuration"] = 0.0
    data["pauseIntervals"] = []
    data["movie"] = MOVIE_FILENAME
    data["url"] = WORKER_URL
    worker_update(data, update_token)
    print(f"✓ Время обновлено: {format_time(new)}")

def toggle_pause(update_token):
    data = read_show()
    if not data:
        print("Показ ещё не создан.")
        return

    now = datetime.now(timezone.utc).timestamp()
    start = data.get("startUnix")

    if not isinstance(start, (int, float)):
        start = datetime.fromisoformat(data["start"]).timestamp()
        data["startUnix"] = start

    if now < start:
        print("Показ ещё не начался.")
        return

    intervals = [x for x in data.get("pauseIntervals", []) if isinstance(x, dict)]

    if not data.get("pause"):
        pos = max(0.0, now - start - paused_duration({"pauseIntervals": intervals}))
        intervals.append({"startUnix": now, "endUnix": None, "position": pos})
        data["pause"] = True
        data["pauseUnix"] = now
        data["pausePosition"] = pos
        data["pausedDuration"] = paused_duration({"pauseIntervals": intervals[:-1]})
    else:
        opened = next((x for x in reversed(intervals) if x.get("endUnix") is None), None)
        if not opened:
            raise RuntimeError("Активная пауза указана, но открытый pauseInterval не найден.")
        if now < float(opened["startUnix"]):
            raise RuntimeError("Некорректные timestamps паузы.")

        opened["endUnix"] = now
        total = paused_duration({"pauseIntervals": intervals})
        data["pause"] = False
        data["pauseUnix"] = None
        data["pausePosition"] = max(0.0, now - start - total)
        data["pausedDuration"] = total

    data["pauseIntervals"] = intervals
    data["movie"] = MOVIE_FILENAME
    data["url"] = WORKER_URL
    worker_update(data, update_token)

    state = "включена" if data["pause"] else "выключена"
    print(f"✓ Пауза {state}.")
    print(f"✓ Позиция: {format_duration(data['pausePosition'])}")

    if not data["pause"]:
        print(f"✓ Суммарное время пауз: {format_duration(data['pausedDuration'])}")

def current_show():
    data = read_show()

    if not data:
        print("Показ не запланирован.")
        return

    try:
        start = format_time(datetime.fromisoformat(data["start"]))
    except (KeyError, TypeError, ValueError):
        start = "—"

    elapsed = position(data)

    print(f"\nID показа: {data.get('showId', '—')}")
    print(f"Время показа: {start}")
    print(f"Просмотрено: {format_duration(elapsed)}")
    print(f"Пауза: {'включена' if data.get('pause') else 'выключена'}")
    print(f"Завершённых пауз: {sum(1 for x in data.get('pauseIntervals', []) if isinstance(x, dict) and isinstance(x.get('endUnix'), (int, float)))}")
    print(f"Файл: {MOVIE_FILENAME}")
    print(f"URL: {data.get('url', WORKER_URL)}")

def verify_current(owner, github_repo, github_token):
    data = read_show()
    release = get_release(owner, github_repo, github_token)
    asset = verify_movie(release)

    print(f"✓ {MOVIE_FILENAME} найден: {asset['size']:,} байт")

    if data:
        print("✓ show.json получен из Worker KV")
        print(f"✓ showId: {data.get('showId', 'нет')}")
        print(f"✓ pause: {data.get('pause', False)}")
    else:
        print("⚠ Текущий показ отсутствует в Worker KV.")

def find_repo():
    env_repo = os.getenv("REPO_DIR")

    if env_repo:
        return Path(env_repo).expanduser().resolve()

    repo = Path(__file__).resolve().parent

    while repo != repo.parent:
        if (repo / ".git").exists():
            return repo
        repo = repo.parent

    raise RuntimeError("Не удалось найти корень Git-репозитория.")

def main():
    repo = find_repo()
    owner, github_repo, github_token, update_token = config(repo)

    while True:
        print("\n1. Проверить movie.mp4 и создать/обновить показ")
        print("2. Показать текущий показ")
        print("3. Изменить время показа")
        print("4. Проверить текущий фильм")
        print("5. Переключить паузу")

        choice = input("\nВыбор: ").strip()

        try:
            if choice == "1":
                create_show(owner, github_repo, github_token, update_token)
            elif choice == "2":
                current_show()
            elif choice == "3":
                change_time(update_token)
            elif choice == "4":
                verify_current(owner, github_repo, github_token)
            elif choice == "5":
                toggle_pause(update_token)
            else:
                print("Неизвестный пункт меню.")

        except KeyboardInterrupt:
            print("\nОперация отменена.")
        except Exception as e:
            print(f"\nERROR: {e}")

if __name__ == "__main__":
    main()