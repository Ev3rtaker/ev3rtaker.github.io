#!/usr/bin/env python3
import getpass
import json
import os
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

TZ = ZoneInfo("Europe/Moscow")
GITHUB_API = "https://api.github.com"
RELEASE_TAG = "current-movie"
MOVIE_FILENAME = "movie.mp4"
MOVIE_PROXY_URL = "https://raspy-cake-1c1a.qwgvpgy.workers.dev"
SHOW_UPDATE_URL = MOVIE_PROXY_URL + "/update-show"
USER_AGENT = "GitHub-Movie-Scheduler/6.0"


def load_env():
    here = Path(__file__).resolve().parent
    for env_file in (here / ".env", here.parent / ".env"):
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] == '"':
                value = value[1:-1]
            os.environ.setdefault(key.strip(), value)
        return


def github_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": USER_AGENT,
    }


def get_release(owner, repo, token):
    url = f"{GITHUB_API}/repos/{owner}/{repo}/releases/tags/{RELEASE_TAG}"
    response = requests.get(url, headers=github_headers(token), timeout=30)
    if response.status_code == 404:
        return None
    if not response.ok:
        raise RuntimeError(
            f"GitHub {response.status_code}: "
            f"{response.text.strip() or response.reason}"
        )
    return response.json()


def find_asset(release):
    return next(
        (a for a in release.get("assets", []) if a.get("name") == MOVIE_FILENAME),
        None,
    )


def verify_movie(release):
    asset = find_asset(release)
    if not asset:
        raise RuntimeError(f"В Release нет файла {MOVIE_FILENAME}.")
    if asset.get("state") != "uploaded":
        raise RuntimeError(
            f"{MOVIE_FILENAME} имеет состояние {asset.get('state')!r}."
        )
    if not asset.get("size") or asset["size"] <= 0:
        raise RuntimeError(f"{MOVIE_FILENAME} имеет некорректный размер.")
    return asset


def update_worker_show(data):
    token = os.environ.get("SHOW_UPDATE_TOKEN")
    if not token:
        raise RuntimeError(
            "Не задана переменная окружения SHOW_UPDATE_TOKEN."
        )

    response = requests.post(
        SHOW_UPDATE_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        json=data,
        timeout=30,
    )

    if not response.ok:
        raise RuntimeError(
            f"Worker {response.status_code}: "
            f"{response.text.strip() or response.reason}"
        )

    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError(
            "Worker вернул некорректный JSON."
        ) from exc


def parse_time(value):
    try:
        return datetime.strptime(
            value.strip(),
            "%Y-%m-%d %H:%M",
        ).replace(tzinfo=TZ)
    except ValueError as exc:
        raise ValueError(
            "Время должно быть в формате YYYY-MM-DD HH:MM"
        ) from exc


def format_time(value):
    return value.astimezone(TZ).strftime("%Y-%m-%d %H:%M")


def format_duration(seconds):
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def read_show(repo):
    path = repo / "show.json"
    if not path.exists():
        return None

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"show.json повреждён: {exc}") from exc


def save_show(repo, data):
    (repo / "show.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def new_show_id():
    return uuid.uuid4().hex


def get_paused_duration(data):
    total = 0.0

    for item in data.get("pauseIntervals", []):
        if not isinstance(item, dict):
            continue

        start = item.get("startUnix")
        end = item.get("endUnix")

        if (
            isinstance(start, (int, float))
            and isinstance(end, (int, float))
            and end >= start
        ):
            total += float(end) - float(start)

    return max(0.0, total)


def show_position(data, now_unix=None):
    if now_unix is None:
        now_unix = datetime.now(timezone.utc).timestamp()

    start_unix = data.get("startUnix")

    if not isinstance(start_unix, (int, float)):
        try:
            start_unix = datetime.fromisoformat(
                data["start"]
            ).timestamp()
        except (KeyError, TypeError, ValueError):
            return 0.0

    if now_unix < start_unix:
        return 0.0

    if data.get("pause"):
        return max(
            0.0,
            float(data.get("pausePosition", 0.0) or 0.0),
        )

    return max(
        0.0,
        now_unix - float(start_unix) - get_paused_duration(data),
    )


def get_movie_duration(url):
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )

        duration = float(result.stdout.strip())
        return duration if duration > 0 else None

    except (
        FileNotFoundError,
        subprocess.SubprocessError,
        ValueError,
    ):
        return None


def write_show(repo, start, asset):
    data = {
        "showId": new_show_id(),
        "start": start.isoformat(),
        "startUnix": start.timestamp(),
        "pause": False,
        "pauseUnix": None,
        "pausePosition": 0.0,
        "pausedDuration": 0.0,
        "pauseIntervals": [],
        "movie": MOVIE_FILENAME,
        "size": asset["size"],
        "mime": "video/mp4",
        "url": MOVIE_PROXY_URL,
    }

    save_show(repo, data)
    update_worker_show(data)
    return data


def ask_time(prompt, default=None):
    while True:
        suffix = f" [{format_time(default)}]" if default else ""
        value = input(f"{prompt}{suffix}: ").strip()

        if not value and default:
            return default

        try:
            return parse_time(value)
        except ValueError as exc:
            print(f"Ошибка: {exc}")


def get_config(repo):
    load_env()

    owner = os.environ.get(
        "GITHUB_OWNER",
        "Ev3rtaker",
    )

    github_repo = (
        os.environ.get("GITHUB_REPO")
        or repo.name
    )

    token = os.environ.get("GITHUB_TOKEN")

    if not token:
        token = getpass.getpass(
            "GitHub Token: "
        ).strip()

    if not token:
        raise RuntimeError(
            "GitHub Token не указан."
        )

    if not os.environ.get("SHOW_UPDATE_TOKEN"):
        raise RuntimeError(
            "Не задана переменная окружения SHOW_UPDATE_TOKEN."
        )

    return owner, github_repo, token


def show_current(repo):
    data = read_show(repo)

    if not data:
        print(
            "\nПоказ не запланирован: show.json отсутствует."
        )
        return

    try:
        start_text = format_time(
            datetime.fromisoformat(data["start"])
        )
    except (KeyError, TypeError, ValueError):
        start_text = "—"

    total = data.get("duration")

    if not isinstance(total, (int, float)) or total <= 0:
        total = get_movie_duration(data.get("url"))

    elapsed = show_position(data)

    if total:
        progress = (
            f"{format_duration(min(elapsed, total))} "
            f"из {format_duration(total)}"
        )
    else:
        progress = (
            f"{format_duration(elapsed)} "
            f"из неизвестной длительности"
        )

    print(f"\nВремя показа: {start_text}")
    print(f"Просмотрено: {progress}")
    print(
        f"Пауза: "
        f"{'включена' if data.get('pause') else 'выключена'}"
    )
    print(f"Файл: {MOVIE_FILENAME}")
    print(f"URL: {data.get('url', '—')}")


def create_or_replace(repo, owner, github_repo, token):
    print(
        "\n=== Проверка movie.mp4 и создание показа ==="
    )
    print("Фильм не загружается скриптом.")

    release = get_release(
        owner,
        github_repo,
        token,
    )

    if not release:
        raise RuntimeError(
            "Release current-movie не найден. "
            "Сначала загрузите movie.mp4 вручную."
        )

    asset = verify_movie(release)

    start = ask_time(
        "Время показа",
        datetime.now(TZ),
    )

    write_show(
        repo,
        start,
        asset,
    )

    print(
        f"✓ Показ создан: {format_time(start)}"
    )
    print(
        "✓ show.json отправлен в Cloudflare KV."
    )


def change_time(repo):
    data = read_show(repo)

    if not data:
        print("\nПоказ ещё не создан.")
        return

    old = datetime.fromisoformat(
        data["start"]
    )

    new_time = ask_time(
        "Новое время",
        old,
    )

    data.update({
        "showId": new_show_id(),
        "start": new_time.isoformat(),
        "startUnix": new_time.timestamp(),
        "pause": False,
        "pauseUnix": None,
        "pausePosition": 0.0,
        "pausedDuration": 0.0,
        "pauseIntervals": [],
        "movie": MOVIE_FILENAME,
        "url": MOVIE_PROXY_URL,
    })

    save_show(
        repo,
        data,
    )

    update_worker_show(data)

    print(
        f"✓ Время обновлено: {format_time(new_time)}"
    )
    print(
        "✓ show.json отправлен в Cloudflare KV."
    )


def verify_current(repo, owner, github_repo, token):
    data = read_show(repo)

    if not data:
        print(
            "\nНет show.json — нечего проверять."
        )
        return

    release = get_release(
        owner,
        github_repo,
        token,
    )

    if not release:
        print(
            "✗ Release current-movie не найден."
        )
        return

    try:
        asset = verify_movie(release)

        print(
            f"\n✓ {MOVIE_FILENAME} найден"
        )
        print(
            f"✓ Размер: {asset['size']:,} байт"
        )
        print(
            f"✓ Worker URL: {MOVIE_PROXY_URL}"
        )

        if data.get("url") == MOVIE_PROXY_URL:
            print(
                "✓ show.json использует Worker URL."
            )
        else:
            print(
                "⚠ show.json использует не Worker URL."
            )

    except RuntimeError as exc:
        print(
            f"\n✗ Проверка не пройдена: {exc}"
        )


def toggle_pause(repo):
    data = read_show(repo)

    if not data:
        print("\nПоказ ещё не создан.")
        return

    now = datetime.now(
        timezone.utc
    ).timestamp()

    start = data.get("startUnix")

    if not isinstance(start, (int, float)):
        try:
            start = datetime.fromisoformat(
                data["start"]
            ).timestamp()
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError(
                "В show.json отсутствует корректное время начала."
            ) from exc

        data["startUnix"] = start

    if now < start:
        print("\nПоказ ещё не начался.")
        return

    intervals = []

    for item in data.get("pauseIntervals", []):
        if not isinstance(item, dict):
            continue

        begin = item.get("startUnix")
        end = item.get("endUnix")

        if not isinstance(begin, (int, float)):
            continue

        if end is not None and not isinstance(end, (int, float)):
            continue

        if end is not None and end < begin:
            continue

        intervals.append(item)

    if not data.get("pause", False):
        completed = get_paused_duration({
            "pauseIntervals": intervals
        })

        position = max(
            0.0,
            now - start - completed,
        )

        intervals.append({
            "startUnix": now,
            "endUnix": None,
            "position": position,
        })

        data.update({
            "pause": True,
            "pauseUnix": now,
            "pausePosition": position,
            "pausedDuration": completed,
        })

    else:
        open_interval = next(
            (
                item
                for item in reversed(intervals)
                if item.get("endUnix") is None
            ),
            None,
        )

        if open_interval is None:
            raise RuntimeError(
                "В show.json указана активная пауза, "
                "но открытый pauseInterval не найден."
            )

        if now < float(open_interval["startUnix"]):
            raise RuntimeError(
                "Некорректные timestamps паузы."
            )

        open_interval["endUnix"] = now

        total_paused = get_paused_duration({
            "pauseIntervals": intervals
        })

        position = max(
            0.0,
            now - start - total_paused,
        )

        data.update({
            "pause": False,
            "pauseUnix": None,
            "pausePosition": position,
            "pausedDuration": total_paused,
        })

    data["pauseIntervals"] = intervals
    data["movie"] = MOVIE_FILENAME
    data["url"] = MOVIE_PROXY_URL

    save_show(
        repo,
        data,
    )

    update_worker_show(data)

    print(
        f"✓ Пауза "
        f"{'включена' if data['pause'] else 'выключена'}."
    )
    print(
        f"✓ Позиция: "
        f"{format_duration(data['pausePosition'])}"
    )


def main():
    repo = Path(
        os.environ.get(
            "REPO_DIR",
            str(Path(__file__).resolve().parent),
        )
    ).expanduser().resolve()

    if not (repo / ".git").exists():
        raise RuntimeError(
            f"{repo} не является Git-репозиторием."
        )

    owner, github_repo, token = get_config(repo)

    while True:
        print(
            "\n╔══════════════════════════════════════╗"
        )
        print(
            "║       GitHub Movie Scheduler         ║"
        )
        print(
            "╚══════════════════════════════════════╝"
        )
        print(
            f"\n{owner}/{github_repo} • "
            f"{RELEASE_TAG}/{MOVIE_FILENAME}\n"
        )

        print(
            "1. Проверить movie.mp4 и создать/обновить показ"
        )
        print(
            "2. Показать текущий показ"
        )
        print(
            "3. Изменить время показа"
        )
        print(
            "4. Проверить текущий фильм"
        )
        print(
            "5. Переключить паузу"
        )
        print()

        choice = input(
            "Выбор: "
        ).strip()

        try:
            if choice == "1":
                create_or_replace(
                    repo,
                    owner,
                    github_repo,
                    token,
                )
            elif choice == "2":
                show_current(repo)
            elif choice == "3":
                change_time(repo)
            elif choice == "4":
                verify_current(
                    repo,
                    owner,
                    github_repo,
                    token,
                )
            elif choice == "5":
                toggle_pause(repo)
            else:
                print(
                    "Неизвестный пункт меню."
                )

        except KeyboardInterrupt:
            print(
                "\nОперация отменена."
            )
        except Exception as exc:
            print(
                f"\nERROR: {exc}"
            )


if __name__ == "__main__":
    main()