#!/usr/bin/env python3

import getpass
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests


TZ = ZoneInfo("Europe/Moscow")
GITHUB_API = "https://api.github.com"
RELEASE_TAG = "current-movie"
CHUNK_SIZE = 900 * 1024 * 1024
USER_AGENT = "GitHub-Movie-Scheduler/1.0"


def load_env():
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.exists():
        return

    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
            value = value[1:-1]

        os.environ.setdefault(key, value)


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

    response = requests.request(
        method,
        url,
        headers=headers,
        timeout=120,
        **kwargs,
    )

    if not response.ok:
        text = response.text.strip()
        raise RuntimeError(
            f"GitHub {response.status_code}: {text or response.reason}"
        )

    if response.content:
        return response.json()

    return None


def parse_time(value):
    try:
        return datetime.strptime(
            value.strip(),
            "%Y-%m-%d %H:%M",
        ).replace(tzinfo=TZ)
    except ValueError:
        raise ValueError(
            "Время должно быть в формате YYYY-MM-DD HH:MM"
        )


def format_time(value):
    return value.astimezone(TZ).strftime("%Y-%m-%d %H:%M")


def get_duration(video):
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
                str(video),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "Не найден ffprobe. Установите FFmpeg и добавьте его в PATH."
        )
    except subprocess.CalledProcessError as error:
        message = error.stderr.strip() if error.stderr else "неизвестная ошибка"
        raise RuntimeError(f"ffprobe не смог прочитать длительность: {message}")

    try:
        duration = float(result.stdout.strip())
    except ValueError:
        raise RuntimeError("ffprobe вернул некорректную длительность.")

    if duration <= 0:
        raise RuntimeError("Продолжительность фильма определилась как 0.")

    return duration


def split_file(source, directory):
    directory.mkdir(parents=True, exist_ok=True)
    parts = []

    with open(source, "rb") as src:
        index = 0

        while True:
            data = src.read(CHUNK_SIZE)
            if not data:
                break

            path = directory / f"movie.part{index:04d}"

            with open(path, "wb") as dst:
                dst.write(data)

            parts.append({
                "path": path,
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            })

            index += 1

    return parts


def get_release(owner, repo, token):
    url = f"{GITHUB_API}/repos/{owner}/{repo}/releases/tags/{RELEASE_TAG}"

    response = requests.get(
        url,
        headers=github_headers(token),
        timeout=30,
    )

    if response.status_code == 404:
        return None

    if not response.ok:
        raise RuntimeError(
            f"GitHub {response.status_code}: {response.text.strip()}"
        )

    return response.json()


def delete_release(owner, repo, release, token):
    github_request(
        "DELETE",
        f"{GITHUB_API}/repos/{owner}/{repo}/releases/{release['id']}",
        token,
    )

    # После удаления release GitHub обычно удаляет tag автоматически,
    # но на всякий случай проверяем и удаляем оставшийся ref.
    ref_url = (
        f"{GITHUB_API}/repos/{owner}/{repo}/git/refs/tags/{RELEASE_TAG}"
    )
    response = requests.delete(
        ref_url,
        headers=github_headers(token),
        timeout=30,
    )

    if response.status_code not in (204, 404):
        raise RuntimeError(
            f"Не удалось удалить tag: {response.status_code}: "
            f"{response.text.strip()}"
        )


def create_release(owner, repo, token):
    return github_request(
        "POST",
        f"{GITHUB_API}/repos/{owner}/{repo}/releases",
        token,
        json={
            "tag_name": RELEASE_TAG,
            "name": "Current Movie",
            "body": "Temporary movie storage.",
            "draft": False,
            "prerelease": False,
        },
    )


def upload_asset(upload_url, token, path):
    """Upload one Release asset as raw binary."""
    upload_url = upload_url.split("{", 1)[0]
    size = path.stat().st_size

    headers = {
        **github_headers(token),
        "Content-Type": "video/mp4",
        "Content-Length": str(size),
        "Expect": "",
    }

    def do_upload(session):
        with open(path, "rb") as file:
            return session.post(
                upload_url,
                params={"name": path.name},
                headers=headers,
                data=file,
                timeout=(30, 60 * 60),
                allow_redirects=False,
            )

    try:
        response = do_upload(requests.Session())

        # uploads.github.com can be broken by a system HTTP(S) proxy.
        # Retry once with proxy/environment settings completely disabled.
        if response.status_code == 400:
            direct = requests.Session()
            direct.trust_env = False
            try:
                response = do_upload(direct)
            finally:
                direct.close()
    except requests.RequestException as error:
        raise RuntimeError(f"Ошибка HTTP при загрузке {path.name}: {error}")

    if response.status_code not in (200, 201):
        body = response.text.strip()
        if len(body) > 1000:
            body = body[:1000] + "... (ответ обрезан)"
        raise RuntimeError(
            f"Upload failed: HTTP {response.status_code}: {body}"
        )

    try:
        return response.json()
    except ValueError:
        raise RuntimeError(
            f"GitHub принял загрузку {path.name}, но вернул некорректный JSON."
        )


def find_asset(release, name):
    for asset in release.get("assets", []):
        if asset.get("name") == name:
            return asset
    return None


def verify_asset(owner, repo, token, asset_name, expected_size=None):
    release = get_release(owner, repo, token)
    if not release:
        return None, "Release не найден."

    asset = find_asset(release, asset_name)
    if not asset:
        return release, f"Asset {asset_name} не найден."

    actual_size = asset.get("size")
    state = asset.get("state")

    if state != "uploaded":
        return release, (
            f"Asset найден, но его состояние: {state!r}."
        )

    if expected_size is not None and actual_size != expected_size:
        return release, (
            f"Asset найден, но размер не совпадает: "
            f"GitHub={actual_size}, ожидается={expected_size}."
        )

    return release, "OK"


def write_show(repo, title, start, duration, size, chunks):
    data = {
        "title": title,
        "start": start.isoformat(),
        "duration": duration,
        "size": size,
        "mime": "video/mp4",
        "chunks": chunks,
    }

    path = repo / "show.json"
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def read_show(repo):
    path = repo / "show.json"
    if not path.exists():
        return None

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"show.json повреждён: {error}")


def run(cmd, cwd=None):
    subprocess.run(cmd, cwd=cwd, check=True)


def git_update_show(repo, message):
    run(["git", "add", "show.json"], cwd=repo)

    # Если изменений нет, commit завершится ошибкой. Это нормально.
    diff = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=repo,
    )

    if diff.returncode == 0:
        print("Git: show.json не изменился, новый коммит не нужен.")
        return

    run(["git", "commit", "-m", message], cwd=repo)
    run(["git", "push"], cwd=repo)


def ask_nonempty(prompt, default=None):
    while True:
        suffix = f" [{default}]" if default is not None else ""
        value = input(f"{prompt}{suffix}: ").strip()

        if not value and default is not None:
            return default

        if value:
            return value

        print("Значение не может быть пустым.")


def ask_time(prompt, default=None):
    while True:
        value = input(
            f"{prompt}"
            f"{f' [{format_time(default)}]' if default else ''}: "
        ).strip()

        if not value and default:
            return default

        try:
            return parse_time(value)
        except ValueError as error:
            print(f"Ошибка: {error}")


def ask_video():
    while True:
        value = input("Путь к MP4: ").strip().strip('"').strip("'")
        if not value:
            print("Путь не может быть пустым.")
            continue

        video = Path(value).expanduser().resolve()

        if not video.is_file():
            print(f"Файл не найден: {video}")
            continue

        if video.suffix.lower() != ".mp4":
            print("Видео должно быть MP4.")
            continue

        return video


def confirm(prompt, default=False):
    suffix = "[Y/n]" if default else "[y/N]"

    while True:
        value = input(f"{prompt} {suffix}: ").strip().lower()

        if not value:
            return default

        if value in ("y", "yes", "д", "да"):
            return True

        if value in ("n", "no", "н", "нет"):
            return False


def show_current(repo):
    data = read_show(repo)

    if not data:
        print("\nПоказ не запланирован: show.json отсутствует.\n")
        return

    print("\nТекущий показ")
    print("-" * 60)
    print(f"Название:      {data.get('title', '—')}")

    start = data.get("start")
    if start:
        try:
            dt = datetime.fromisoformat(start)
            print(f"Время показа:  {format_time(dt)}")
        except ValueError:
            print(f"Время показа:  {start}")

    duration = data.get("duration")
    if duration is not None:
        print(f"Длительность:  {duration:.3f} сек.")

    print(f"Размер:         {data.get('size', '—')} байт")

    chunks = data.get("chunks", [])
    print(f"Частей:         {len(chunks)}")

    for chunk in chunks:
        print(f"  {chunk.get('name')}")
        print(f"    URL: {chunk.get('url', '—')}")

    print()


def get_config(repo):
    load_env()

    owner = os.environ.get("GITHUB_OWNER", "Ev3rtaker")
    github_repo = os.environ.get("GITHUB_REPO")

    if not github_repo:
        github_repo = repo.name

    token = os.environ.get("GITHUB_TOKEN")

    if not token:
        print("\nGitHub Token не найден в .env.")
        print("Он нужен только для GitHub API, SSH-ключи для этого скрипта не используются.")
        token = getpass.getpass("GitHub Token: ").strip()

    if not token:
        raise RuntimeError("GitHub Token не указан.")

    return owner, github_repo, token


def verify_current(repo, owner, github_repo, token):
    data = read_show(repo)

    if not data:
        print("\nНет show.json — нечего проверять.\n")
        return

    chunks = data.get("chunks", [])

    if not chunks:
        print("\nВ show.json нет частей фильма.\n")
        return

    print("\nПроверка GitHub Release...")
    release = get_release(owner, github_repo, token)

    if not release:
        print("✗ Release current-movie не найден.")
        return

    print(f"✓ Release найден: {release.get('html_url')}")

    all_ok = True

    for chunk in chunks:
        name = chunk["name"]
        expected_size = chunk.get("size")

        asset = find_asset(release, name)

        if not asset:
            print(f"✗ {name}: asset не найден")
            all_ok = False
            continue

        actual_size = asset.get("size")
        state = asset.get("state")

        if state != "uploaded":
            print(f"✗ {name}: state={state!r}")
            all_ok = False
            continue

        if expected_size is not None and actual_size != expected_size:
            print(
                f"✗ {name}: размер отличается "
                f"(GitHub {actual_size}, ожидалось {expected_size})"
            )
            all_ok = False
            continue

        print(f"✓ {name}: загружен, {actual_size} байт")
        print(f"  URL: {asset.get('browser_download_url')}")

    if all_ok:
        print("\n✓ Все части действительно присутствуют на GitHub.\n")
    else:
        print("\n✗ Проверка обнаружила проблемы.\n")


def create_or_replace(repo, owner, github_repo, token):
    print("\n=== Новый показ ===\n")

    video = ask_video()

    print("\nОпределение продолжительности...")
    duration = get_duration(video)
    print(f"Продолжительность: {duration:.3f} сек.")

    title = ask_nonempty(
        "Название фильма",
        video.stem,
    )

    start = ask_time("Время показа", datetime.now(TZ))

    print("\nПараметры:")
    print(f"  Файл:           {video}")
    print(f"  Название:       {title}")
    print(f"  Время:          {format_time(start)} (Москва)")
    print(f"  Размер:         {video.stat().st_size} байт")
    print(f"  Длительность:   {duration:.3f} сек.")

    if not confirm("\nНачать загрузку?"):
        print("Отменено.")
        return

    temp = Path(tempfile.mkdtemp(prefix="movie-parts-"))

    release = None
    created_release = None

    try:
        print("\nРазбиение фильма...")
        parts = split_file(video, temp)
        print(f"Получено частей: {len(parts)}")

        release = get_release(owner, github_repo, token)

        if release:
            print("\nОбнаружен предыдущий Release current-movie.")

            if not confirm("Удалить предыдущий фильм и заменить его?"):
                print("Отменено.")
                return

            print("Удаление предыдущего Release...")
            delete_release(owner, github_repo, release, token)

        print("Создание Release...")
        release = create_release(owner, github_repo, token)
        created_release = release

        chunks = []

        for number, part in enumerate(parts, 1):
            print(
                f"\n[{number}/{len(parts)}] "
                f"Загрузка {part['path'].name}..."
            )

            asset = upload_asset(
                release["upload_url"],
                token,
                part["path"],
            )

            chunks.append({
                "name": part["path"].name,
                "size": part["size"],
                "sha256": part["sha256"],
                "url": asset["browser_download_url"],
            })

            print(f"✓ Загружено: {asset['browser_download_url']}")

        write_show(
            repo,
            title,
            start,
            duration,
            video.stat().st_size,
            chunks,
        )

        print("\nПроверяем загрузку через GitHub API...")
        verify_current(repo, owner, github_repo, token)

        print("\nОбновление Git...")
        git_update_show(repo, "Update movie schedule")

        print("\n✓ Готово.")
        print(f"Время показа: {format_time(start)}")
        print(f"Название: {title}")

        for chunk in chunks:
            print(f"URL: {chunk['url']}")

    except Exception:
        if created_release:
            try:
                print("\nОчистка незавершённого Release...")
                delete_release(owner, github_repo, created_release, token)
                print("Незавершённый Release удалён.")
            except Exception as cleanup_error:
                print(f"Не удалось удалить незавершённый Release: {cleanup_error}")
        raise

    finally:
        shutil.rmtree(temp, ignore_errors=True)


def change_time(repo):
    data = read_show(repo)

    if not data:
        print("\nПоказ ещё не создан.\n")
        return

    old_value = data.get("start")
    old_time = None

    if old_value:
        try:
            old_time = datetime.fromisoformat(old_value)
        except ValueError:
            pass

    print("\n=== Изменение времени показа ===")
    print(f"Текущее время: {format_time(old_time) if old_time else old_value}")

    new_time = ask_time("Новое время", old_time)

    data["start"] = new_time.isoformat()

    (repo / "show.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"Новое время: {format_time(new_time)}")

    if confirm("Сохранить изменение в Git и выполнить push?"):
        git_update_show(repo, "Update movie schedule")
        print("✓ Время обновлено.")


def show_urls(repo):
    data = read_show(repo)

    if not data:
        print("\nПоказ ещё не создан.\n")
        return

    print("\n=== URL загруженных файлов ===")

    for chunk in data.get("chunks", []):
        print(f"\n{chunk.get('name')}")
        print(chunk.get("url", "URL отсутствует"))

    print()


def main():
    repo = Path(
        os.environ.get(
            "REPO_DIR",
            str(Path(__file__).resolve().parent.parent),
        )
    ).expanduser().resolve()

    if not (repo / ".git").exists():
        raise RuntimeError(
            f"{repo} не является Git-репозиторием."
        )

    owner, github_repo, token = get_config(repo)

    while True:
        print("\n")
        print("╔══════════════════════════════════════════╗")
        print("║       GitHub Movie Scheduler             ║")
        print("╚══════════════════════════════════════════╝")
        print()
        print(f"Репозиторий: {owner}/{github_repo}")
        print()

        print("1. Новый показ / загрузить фильм")
        print("2. Показать текущий показ")
        print("3. Изменить время показа")
        print("4. Проверить загрузку на GitHub")
        print("5. Показать URL загруженного файла")
        print("6. Выход")
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
                show_urls(repo)

            elif choice == "6":
                print("Выход.")
                return

            else:
                print("Неизвестный пункт меню.")

        except KeyboardInterrupt:
            print("\nОперация отменена.")
        except Exception as error:
            print(f"\nERROR: {error}")

        input("\nНажмите Enter, чтобы продолжить...")


if __name__ == "__main__":
    main()
