#!/usr/bin/env python3

import argparse
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

CHUNK_SIZE = 1900 * 1024 * 1024


def load_env():
    env_file = (
        Path(__file__).resolve().parent.parent
        / ".env"
    )

    if not env_file.exists():
        raise RuntimeError(
            f"Не найден файл .env: {env_file}"
        )

    for line in env_file.read_text(
        encoding="utf-8"
    ).splitlines():

        line = line.strip()

        if (
            not line
            or line.startswith("#")
        ):
            continue

        if "=" not in line:
            continue

        key, value = line.split(
            "=",
            1
        )

        key = key.strip()
        value = value.strip()

        if (
            len(value) >= 2
            and value[0] == '"'
            and value[-1] == '"'
        ):
            value = value[1:-1]

        os.environ.setdefault(
            key,
            value
        )


def require_env(name):
    value = os.environ.get(name)

    if not value:
        raise RuntimeError(
            f"В .env отсутствует {name}"
        )

    return value


def run(cmd, cwd=None):
    print(
        "+",
        " ".join(cmd)
    )

    subprocess.run(
        cmd,
        cwd=cwd,
        check=True
    )


def github_headers(token):
    return {
        "Authorization":
            f"Bearer {token}",

        "Accept":
            "application/vnd.github+json",

        "X-GitHub-Api-Version":
            "2022-11-28"
    }


def github_request(
    method,
    url,
    token,
    **kwargs
):
    headers = kwargs.pop(
        "headers",
        {}
    )

    headers.update(
        github_headers(token)
    )

    response = requests.request(
        method,
        url,
        headers=headers,
        **kwargs
    )

    if not response.ok:
        raise RuntimeError(
            f"GitHub {response.status_code}: "
            f"{response.text}"
        )

    if response.content:
        return response.json()

    return None


def parse_time(value):
    try:
        return datetime.strptime(
            value,
            "%Y-%m-%d %H:%M"
        ).replace(tzinfo=TZ)

    except ValueError:
        raise ValueError(
            "Время должно быть "
            "в формате YYYY-MM-DD HH:MM"
        )


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
                "default="
                "noprint_wrappers=1:"
                "nokey=1",
                str(video)
            ],
            capture_output=True,
            text=True,
            check=True
        )

    except FileNotFoundError:
        raise RuntimeError(
            "Не найден ffprobe. "
            "Установите FFmpeg и добавьте "
            "его в PATH."
        )

    except subprocess.CalledProcessError as error:
        message = (
            error.stderr.strip()
            if error.stderr
            else "неизвестная ошибка"
        )

        raise RuntimeError(
            f"ffprobe не смог прочитать "
            f"длительность: {message}"
        )

    try:
        duration = float(
            result.stdout.strip()
        )

    except ValueError:
        raise RuntimeError(
            "ffprobe вернул некорректную "
            "длительность."
        )

    if duration <= 0:
        raise RuntimeError(
            "Продолжительность фильма "
            "определилась как 0."
        )

    return duration


def split_file(
    source,
    directory
):
    directory.mkdir(
        parents=True,
        exist_ok=True
    )

    parts = []

    with open(
        source,
        "rb"
    ) as src:

        index = 0

        while True:
            data = src.read(
                CHUNK_SIZE
            )

            if not data:
                break

            path = (
                directory /
                f"movie.part{index:04d}"
            )

            with open(
                path,
                "wb"
            ) as dst:
                dst.write(data)

            parts.append({
                "path": path,
                "size": len(data),
                "sha256":
                    hashlib.sha256(
                        data
                    ).hexdigest()
            })

            index += 1

    return parts


def get_release(
    owner,
    repo,
    token
):
    url = (
        f"{GITHUB_API}/repos/"
        f"{owner}/{repo}/releases/"
        f"tags/{RELEASE_TAG}"
    )

    response = requests.get(
        url,
        headers=github_headers(token)
    )

    if response.status_code == 404:
        return None

    if not response.ok:
        raise RuntimeError(
            response.text
        )

    return response.json()


def delete_release(
    owner,
    repo,
    release,
    token
):
    github_request(
        "DELETE",
        (
            f"{GITHUB_API}/repos/"
            f"{owner}/{repo}/releases/"
            f"{release['id']}"
        ),
        token
    )

    github_request(
        "DELETE",
        (
            f"{GITHUB_API}/repos/"
            f"{owner}/{repo}/git/refs/"
            f"tags/{RELEASE_TAG}"
        ),
        token
    )


def create_release(
    owner,
    repo,
    token
):
    return github_request(
        "POST",
        (
            f"{GITHUB_API}/repos/"
            f"{owner}/{repo}/releases"
        ),
        token,
        json={
            "tag_name":
                RELEASE_TAG,

            "name":
                "Current Movie",

            "body":
                "Temporary movie storage.",

            "draft":
                False,

            "prerelease":
                False
        }
    )


def upload_asset(
    upload_url,
    token,
    path
):
    upload_url = (
        upload_url.split("{")[0]
    )

    with open(path, "rb") as f:
        response = requests.post(
            upload_url,
            params={
                "name": path.name
            },
            headers={
                **github_headers(token),

                "Content-Type":
                    "application/octet-stream"
            },
            data=f
        )

    if not response.ok:
        raise RuntimeError(
            "Upload failed: "
            f"{response.status_code}: "
            f"{response.text}"
        )

    return response.json()


def write_show(
    repo,
    title,
    start,
    duration,
    size,
    chunks
):
    data = {
        "title": title,

        "start":
            start.isoformat(),

        "duration":
            duration,

        "size":
            size,

        "mime":
            "video/mp4",

        "chunks":
            chunks
    }

    path = repo / "show.json"

    path.write_text(
        json.dumps(
            data,
            ensure_ascii=False,
            indent=2
        ) + "\n",
        encoding="utf-8"
    )


def main():
    load_env()

    token = require_env(
        "GITHUB_TOKEN"
    )

    owner = require_env(
        "GITHUB_OWNER"
    )

    github_repo = require_env(
        "GITHUB_REPO"
    )

    repo_dir = os.environ.get(
        "REPO_DIR",
        str(
            Path(__file__).resolve()
            .parent.parent
        )
    )

    parser = argparse.ArgumentParser(
        description=
            "Запланировать кинопоказ."
    )

    parser.add_argument(
        "video",
        help="Путь к MP4"
    )

    parser.add_argument(
        "start",
        help=
            "Начало: "
            "YYYY-MM-DD HH:MM "
            "(Калининград)"
    )

    parser.add_argument(
        "--title",
        help="Название фильма"
    )

    args = parser.parse_args()

    video = (
        Path(args.video)
        .expanduser()
        .resolve()
    )

    repo = (
        Path(repo_dir)
        .expanduser()
        .resolve()
    )

    if not video.is_file():
        raise RuntimeError(
            "Видео не найдено."
        )

    if video.suffix.lower() != ".mp4":
        raise RuntimeError(
            "Видео должно быть MP4."
        )

    if not (
        repo / ".git"
    ).exists():
        raise RuntimeError(
            f"{repo} "
            "не является Git-репозиторием."
        )

    start = parse_time(
        args.start
    )

    title = (
        args.title
        or video.stem
    )

    print(
        "Определение "
        "продолжительности..."
    )

    duration = get_duration(
        video
    )

    print(
        f"Продолжительность: "
        f"{duration:.3f} сек."
    )

    temp = Path(
        tempfile.mkdtemp(
            prefix="movie-parts-"
        )
    )

    try:
        print(
            "Разбиение фильма..."
        )

        parts = split_file(
            video,
            temp
        )

        print(
            f"Получено частей: "
            f"{len(parts)}"
        )

        release = get_release(
            owner,
            github_repo,
            token
        )

        if release:
            print(
                "Удаление "
                "предыдущего фильма..."
            )

            delete_release(
                owner,
                github_repo,
                release,
                token
            )

        print(
            "Создание Release..."
        )

        release = create_release(
            owner,
            github_repo,
            token
        )

        chunks = []

        for part in parts:
            print(
                f"Загрузка "
                f"{part['path'].name}..."
            )

            asset = upload_asset(
                release["upload_url"],
                token,
                part["path"]
            )

            chunks.append({
                "name":
                    part["path"].name,

                "size":
                    part["size"],

                "sha256":
                    part["sha256"],

                "url":
                    asset[
                        "browser_download_url"
                    ]
            })

        write_show(
            repo,
            title,
            start,
            duration,
            video.stat().st_size,
            chunks
        )

        run(
            [
                "git",
                "add",
                "show.json"
            ],
            cwd=repo
        )

        run(
            [
                "git",
                "commit",
                "-m",
                "Update movie schedule"
            ],
            cwd=repo
        )

        run(
            [
                "git",
                "push"
            ],
            cwd=repo
        )

        print()
        print(
            "Готово."
        )

        print(
            f"Начало: "
            f"{start.strftime('%Y-%m-%d %H:%M')} "
            f"(Калининград)"
        )

        print(
            f"Длительность: "
            f"{duration:.3f} сек."
        )

    finally:
        shutil.rmtree(
            temp,
            ignore_errors=True
        )


if __name__ == "__main__":
    try:
        main()

    except KeyboardInterrupt:
        print(
            "\nОтменено."
        )
        sys.exit(130)

    except Exception as error:
        print(
            f"ERROR: {error}",
            file=sys.stderr
        )

        sys.exit(1)