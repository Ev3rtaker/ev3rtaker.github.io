#!/usr/bin/env python3
"""GitHub Movie Scheduler — manual Release upload.

The script never uploads movie.mp4. The movie is always the asset
movie.mp4 in Release current-movie.
"""

import getpass
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

TZ = ZoneInfo("Europe/Moscow")
GITHUB_API = "https://api.github.com"
RELEASE_TAG = "current-movie"
MOVIE_FILENAME = "movie.mp4"
USER_AGENT = "GitHub-Movie-Scheduler-Manual/4.0"


def load_env():
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def github_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": USER_AGENT,
    }


def github_request(method, url, token, **kwargs):
    headers = kwargs.pop("headers", {})
    headers.update(github_headers(token))
    response = requests.request(method, url, headers=headers, timeout=120, **kwargs)
    if not response.ok:
        raise RuntimeError(
            f"GitHub {response.status_code}: {response.text.strip() or response.reason}"
        )
    return response.json() if response.content else None


def parse_time(value):
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    except ValueError:
        raise ValueError("Время должно быть в формате YYYY-MM-DD HH:MM")


def format_time(value):
    return value.astimezone(TZ).strftime("%Y-%m-%d %H:%M")


def get_release(owner, repo, token):
    url = f"{GITHUB_API}/repos/{owner}/{repo}/releases/tags/{RELEASE_TAG}"
    response = requests.get(url, headers=github_headers(token), timeout=30)
    if response.status_code == 404:
        return None
    if not response.ok:
        raise RuntimeError(f"GitHub {response.status_code}: {response.text.strip()}")
    return response.json()


def find_asset(release, name=MOVIE_FILENAME):
    return next((a for a in release.get("assets", []) if a.get("name") == name), None)


def verify_manual_upload(release):
    asset = find_asset(release)
    if not asset:
        raise RuntimeError(f"В Release нет файла {MOVIE_FILENAME}.")
    if asset.get("state") != "uploaded":
        raise RuntimeError(
            f"{MOVIE_FILENAME} найден, но его состояние: {asset.get('state')!r}."
        )
    if not asset.get("size") or asset["size"] <= 0:
        raise RuntimeError(f"{MOVIE_FILENAME} имеет некорректный размер.")
    return asset


def read_show(repo):
    path = repo / "show.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"show.json повреждён: {error}")


def write_show(repo, start, asset, pause=False):
    start_unix = int(start.timestamp())
    data = {
        "start": start.isoformat(),
        "startUnix": start_unix,
        "pause": bool(pause),
        "pauseUnix": int(datetime.now(timezone.utc).timestamp()) if pause else None,
        "pausePosition": 0.0,
        "pausedDuration": 0.0,
        "pauseIntervals": [],
        "movie": MOVIE_FILENAME,
        "size": asset["size"],
        "mime": "video/mp4",
        "url": MOVIE_PROXY_URL,
    }
    (repo / "show.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def run(cmd, cwd=None):
    subprocess.run(cmd, cwd=cwd, check=True)


def ensure_movie_ignored(repo):
    gitignore = repo / ".gitignore"
    existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    if MOVIE_FILENAME not in existing.splitlines():
        with gitignore.open("a", encoding="utf-8") as file:
            if existing and not existing.endswith("\n"):
                file.write("\n")
            file.write(f"{MOVIE_FILENAME}\n")


def git_update_show(repo, message):
    run(["git", "add", "--", "show.json", ".gitignore"], cwd=repo)
    diff = subprocess.run(
        ["git", "diff", "--cached", "--quiet", "--", "show.json", ".gitignore"],
        cwd=repo,
    )
    if diff.returncode == 0:
        print("Git: изменений нет.")
        return
    run(["git", "commit", "-m", message], cwd=repo)
    run(["git", "push"], cwd=repo)


def ask_time(prompt, default=None):
    while True:
        suffix = f" [{format_time(default)}]" if default else ""
        value = input(f"{prompt}{suffix}: ").strip()
        if not value and default:
            return default
        try:
            return parse_time(value)
        except ValueError as error:
            print(f"Ошибка: {error}")


def get_config(repo):
    load_env()
    owner = os.environ.get("GITHUB_OWNER", "Ev3rtaker")
    github_repo = os.environ.get("GITHUB_REPO") or repo.name
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        token = getpass.getpass("GitHub Token: ").strip()
    if not token:
        raise RuntimeError("GitHub Token не указан.")
    return owner, github_repo, token


def get_movie_duration(url, token=None):
    """Return movie duration in seconds using ffprobe, or None if unavailable."""
    if not url:
        return None

    command = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
    ]

    if token:
        command += ["-headers", f"Authorization: Bearer {token}\r\n"]

    command.append(url)

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        duration = float(result.stdout.strip())
        return duration if duration > 0 else None
    except (FileNotFoundError, subprocess.SubprocessError, ValueError):
        return None


def format_duration(seconds):
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def show_position(data, now_unix=None):
    if now_unix is None:
        now_unix = datetime.now(timezone.utc).timestamp()

    start_unix = data.get("startUnix")
    if not isinstance(start_unix, (int, float)):
        try:
            start_unix = datetime.fromisoformat(data["start"]).timestamp()
        except (KeyError, TypeError, ValueError):
            return 0.0

    if data.get("pause"):
        position = data.get("pausePosition", 0.0)
    else:
        paused = float(data.get("pausedDuration", 0.0) or 0.0)
        position = now_unix - float(start_unix) - paused

    return max(0.0, position)


def show_current(repo):
    data = read_show(repo)
    if not data:
        print("\nПоказ не запланирован: show.json отсутствует.")
        return

    start_value = data.get("start")
    start_text = start_value or "—"
    try:
        start_dt = datetime.fromisoformat(start_value)
        start_text = format_time(start_dt)
    except (TypeError, ValueError):
        pass

    total = data.get("duration")
    if isinstance(total, (int, float)) and total > 0:
        total = float(total)
    else:
        total = get_movie_duration(data.get("url"))

    elapsed = show_position(data)
    if total:
        elapsed = min(elapsed, total)
        progress = f"{format_duration(elapsed)} из {format_duration(total)}"
    else:
        progress = f"{format_duration(elapsed)} из неизвестной длительности"

    print(f"\nВремя показа: {start_text}")
    print(f"Просмотрено: {progress}")
    print(f"Пауза: {'включена' if data.get('pause', False) else 'выключена'}")
    if data.get("pause") and data.get("pauseUnix"):
        print(f"Пауза поставлена: Unix {data['pauseUnix']}")
    print(f"Файл: {MOVIE_FILENAME}")
    print(f"URL: {data.get('url', '—')}")


def verify_current(repo, owner, github_repo, token):
    data = read_show(repo)
    if not data:
        print("\nНет show.json — нечего проверять.")
        return
    release = get_release(owner, github_repo, token)
    if not release:
        print("✗ Release current-movie не найден.")
        return
    try:
        asset = verify_manual_upload(release)
        stored_url = data.get("url")
        print(f"\n✓ {MOVIE_FILENAME} найден")
        print(f"✓ Размер: {asset['size']:,} байт")
        print(f"✓ Worker URL: {MOVIE_PROXY_URL}")
        if stored_url == MOVIE_PROXY_URL:
            print("✓ show.json использует Worker URL.")
        else:
            print("⚠ show.json использует не Worker URL.")
    except RuntimeError as error:
        print(f"\n✗ Проверка не пройдена: {error}")


def create_or_replace(repo, owner, github_repo, token):
    print("\n=== Проверка movie.mp4 и создание показа ===")
    print("Фильм не загружается скриптом. Используется Release current-movie/movie.mp4.")
    release = get_release(owner, github_repo, token)
    if not release:
        raise RuntimeError("Release current-movie не найден. Сначала загрузите movie.mp4 вручную.")
    asset = verify_manual_upload(release)
    start = ask_time("Время показа", datetime.now(TZ))
    write_show(repo, start, asset, pause=False)
    git_update_show(repo, "Update movie schedule")
    print(f"✓ Показ создан: {format_time(start)}")


def change_time(repo):
    data = read_show(repo)
    if not data:
        print("\nПоказ ещё не создан.")
        return
    old = datetime.fromisoformat(data["start"])
    new_time = ask_time("Новое время", old)
    data["start"] = new_time.isoformat()
    data["startUnix"] = int(new_time.timestamp())
    data["pause"] = False
    data["pauseUnix"] = None
    data["pausePosition"] = 0.0
    data["pausedDuration"] = 0.0
    data["pauseIntervals"] = []
    data["url"] = MOVIE_PROXY_URL
    (repo / "show.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    git_update_show(repo, "Update movie show time")
    print(f"✓ Время обновлено: {format_time(new_time)}")


def toggle_pause(repo):
    data = read_show(repo)
    if not data:
        print("\nПоказ ещё не создан.")
        return

    now_unix = datetime.now(timezone.utc).timestamp()

    start_unix = data.get("startUnix")
    if not isinstance(start_unix, (int, float)):
        start_unix = datetime.fromisoformat(data["start"]).timestamp()
        data["startUnix"] = float(start_unix)

    intervals = data.get("pauseIntervals")
    if not isinstance(intervals, list):
        intervals = []

    if not bool(data.get("pause", False)):
        # Сумма всех завершённых пауз.
        completed_pause = 0.0
        for item in intervals:
            if not isinstance(item, dict):
                continue
            begin = item.get("startUnix")
            end = item.get("endUnix")
            if isinstance(begin, (int, float)) and isinstance(end, (int, float)):
                completed_pause += max(0.0, float(end) - float(begin))

        # Старые show.json могли хранить только pausedDuration.
        # Не теряем это накопленное время при переходе на intervals.
        if not intervals:
            legacy_paused = float(data.get("pausedDuration", 0.0) or 0.0)
            completed_pause = max(completed_pause, legacy_paused)

        # Фиксируем позицию фильма именно в момент включения паузы.
        position = max(
            0.0,
            now_unix - float(start_unix) - completed_pause
        )

        intervals.append({
            "startUnix": now_unix,
            "endUnix": None,
            "position": position,
        })

        data["pause"] = True
        data["pauseUnix"] = now_unix
        data["pausePosition"] = position

    else:
        # Закрываем последнюю открытую паузу.
        open_interval = None
        for item in reversed(intervals):
            if (
                isinstance(item, dict)
                and isinstance(item.get("startUnix"), (int, float))
                and item.get("endUnix") is None
            ):
                open_interval = item
                break

        if open_interval is not None:
            open_interval["endUnix"] = now_unix

        # Полная сумма всех пауз. Она сохраняется для совместимости
        # и для быстрого чтения, но источником истины остаются intervals.
        total_paused = 0.0
        for item in intervals:
            if not isinstance(item, dict):
                continue
            begin = item.get("startUnix")
            end = item.get("endUnix")
            if isinstance(begin, (int, float)) and isinstance(end, (int, float)):
                total_paused += max(0.0, float(end) - float(begin))

        data["pausedDuration"] = total_paused
        data["pause"] = False
        data["pauseUnix"] = None

    data["pauseIntervals"] = intervals
    data["url"] = MOVIE_PROXY_URL

    (repo / "show.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    git_update_show(repo, "Toggle movie pause")
    print(f"✓ Пауза {'включена' if data['pause'] else 'выключена'}.")


def main():
    repo = Path(os.environ.get("REPO_DIR", str(Path(__file__).resolve().parent.parent))).expanduser().resolve()
    if not (repo / ".git").exists():
        raise RuntimeError(f"{repo} не является Git-репозиторием.")
    owner, github_repo, token = get_config(repo)
    ensure_movie_ignored(repo)

    while True:
        print("\n╔══════════════════════════════════════╗")
        print("║      GitHub Movie Scheduler         ║")
        print("╚══════════════════════════════════════╝")
        print(f"\n{owner}/{github_repo}  •  {RELEASE_TAG}/{MOVIE_FILENAME}\n")
        print("1. Проверить movie.mp4 и создать/обновить показ")
        print("2. Показать текущий показ")
        print("3. Изменить время показа")
        print("4. Проверить текущий фильм")
        print("5. Переключить паузу")
        print()
        choice = input("Выбор: ").strip()
        try:
            if choice == "1":
                create_or_replace(repo, owner, github_repo, token)
            elif choice == "2":
                show_current(repo)
            elif choice == "3":
                change_time(repo)
            elif choice == "4":
                verify_current(repo, owner, github_repo, token)
            elif choice == "5":
                toggle_pause(repo)
            else:
                print("Неизвестный пункт меню.")
        except KeyboardInterrupt:
            print("\nОперация отменена.")
        except Exception as error:
            print(f"\nERROR: {error}")


if __name__ == "__main__":
    main()
