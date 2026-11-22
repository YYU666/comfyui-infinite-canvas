"""Validate a release candidate and publish a fully verified GitHub draft."""
from __future__ import annotations

import argparse
from contextlib import closing
from hashlib import file_digest
from http.client import HTTPSConnection
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import quote, urlencode
from zipfile import ZipFile

from assert_package_evidence import assert_packages
from assert_runtime_evidence import assert_runtime
from build_runtime_package import lock_sha256, runtime_asset_name, runtime_identity
from build_update_package import ROOT, assert_release_tag, parse_version


def assert_versions(tag):
    if not tag.startswith("v") or tag != tag.strip():
        raise RuntimeError("Use an exact v-prefixed release tag.")
    assert_release_tag(tag)
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    if lock["version"] != tag[1:] or lock["packages"][""]["version"] != tag[1:]:
        raise RuntimeError("package-lock.json and the release tag must match.")


def validate_packages(directory, tag):
    identity = runtime_identity()
    manifests = {
        f"refmuse-update-{tag}.zip": ("release-files.json", {"version": tag}),
        f"refmuse-portable-{tag}.zip": ("release-files.json", {"version": tag}),
        runtime_asset_name(): (
            f"{identity}/runtime-manifest.json",
            {"identity": identity, "requirementsLockSha256": lock_sha256()},
        ),
    }
    names = set(manifests) | {name + ".sha256" for name in manifests}
    files = {path.name: path for path in directory.iterdir()}
    if files.keys() != names or any(not path.is_file() for path in files.values()):
        raise RuntimeError("Expected exactly the three named packages and their checksum files.")
    assert_packages(directory)
    assert_runtime(directory)
    for name, (manifest_name, expected_fields) in manifests.items():
        with ZipFile(files[name]) as archive:
            manifest = json.loads(archive.read(manifest_name))
            if any(manifest.get(field) != expected for field, expected in expected_fields.items()):
                raise RuntimeError(f"{name} does not match the release manifest for this source.")
            corrupt_member = archive.testzip()
            if corrupt_member is not None:
                raise RuntimeError(f"{name} has a corrupt ZIP member: {corrupt_member}")
    return files


class GitHubRelease:
    def __init__(self, repository):
        if re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", repository) is None:
            raise RuntimeError("Invalid GitHub repository.")
        self.repository = repository

    def api(self, endpoint, *, body=None, method="GET", paginate=False):
        args = ["gh", "api", "--hostname", "github.com", f"repos/{self.repository}/{endpoint}", "--method", method]
        if paginate:
            args += ["--paginate", "--slurp"]
        if body is not None:
            args += ["--input", "-"]
        result = subprocess.run(
            args,
            input=json.dumps(body) if body is not None else None,
            stdout=subprocess.PIPE,
            encoding="utf-8",
            check=True,
        )
        payload = json.loads(result.stdout)
        return [item for page in payload for item in page] if paginate else payload

    def require_tag(self, tag, sha):
        target = self.api(f"git/ref/tags/{quote(tag, safe='')}")["object"]
        while target["type"] == "tag":
            target = self.api(f"git/tags/{target['sha']}")["object"]
        if target["type"] != "commit" or target["sha"] != sha:
            raise RuntimeError(f"Remote tag {tag} does not target the expected commit {sha}.")

    def upload(self, release_id, path):
        endpoint = f"/repos/{self.repository}/releases/{release_id}/assets?{urlencode({'name': path.name})}"
        headers = {
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
            "Content-Type": "application/octet-stream",
            "Content-Length": str(path.stat().st_size),
            "User-Agent": "Refmuse-Release",
        }
        with closing(HTTPSConnection("uploads.github.com", timeout=300)) as connection, path.open("rb") as asset:
            connection.request("POST", endpoint, body=asset, headers=headers)
            with connection.getresponse() as response:
                if response.status != 201:
                    raise RuntimeError(f"Upload failed for {path.name} (HTTP {response.status}).")


def assert_draft(release, tag, sha):
    if release["tag_name"] != tag or release["draft"] is not True:
        raise RuntimeError("Expected a draft Release for the requested tag. Existing public Releases are never modified.")
    if release["prerelease"] != bool(parse_version(tag)[1]):
        raise RuntimeError("Draft prerelease status does not match the tag.")
    target = release["target_commitish"]
    if re.fullmatch(r"[0-9a-fA-F]{40}", target) and target.lower() != sha:
        raise RuntimeError("Draft target SHA does not match the requested commit.")


def assert_uploaded(assets, expected, *, complete):
    uploaded = set()
    for asset in assets:
        name = asset["name"]
        if name in uploaded or name not in expected:
            raise RuntimeError(f"Unexpected draft asset: {name}")
        if asset["state"] != "uploaded" or (asset["size"], asset["digest"]) != expected[name]:
            raise RuntimeError(f"Draft asset {name} differs from this build. Existing assets are never overwritten.")
        uploaded.add(name)
    if complete and uploaded != expected.keys():
        raise RuntimeError("Draft does not contain all six verified release assets.")
    return uploaded


def publish_release(github, tag, sha, files):
    if re.fullmatch(r"[0-9a-f]{40}", sha) is None:
        raise RuntimeError("Publishing requires a full commit SHA.")
    expected = {}
    for name, path in files.items():
        with path.open("rb") as asset:
            expected[name] = (path.stat().st_size, "sha256:" + file_digest(asset, "sha256").hexdigest())

    github.require_tag(tag, sha)
    matches = [release for release in github.api("releases?per_page=100", paginate=True) if release["tag_name"] == tag]
    if len(matches) > 1:
        raise RuntimeError("Multiple Releases use this tag.")
    if matches:
        draft = matches[0]
    else:
        draft = github.api("releases", method="POST", body={
            "tag_name": tag,
            "target_commitish": sha,
            "draft": True,
            "prerelease": bool(parse_version(tag)[1]),
            "generate_release_notes": True,
        })
    assert_draft(draft, tag, sha)
    release_id = draft["id"]
    endpoint = f"releases/{release_id}"
    assets_endpoint = f"{endpoint}/assets?per_page=100"
    uploaded = assert_uploaded(github.api(assets_endpoint, paginate=True), expected, complete=False)
    for name in sorted(files.keys() - uploaded):
        assert_draft(github.api(endpoint), tag, sha)
        github.upload(release_id, files[name])

    assert_draft(github.api(endpoint), tag, sha)
    assert_uploaded(github.api(assets_endpoint, paginate=True), expected, complete=True)
    github.require_tag(tag, sha)
    result = github.api(endpoint, method="PATCH", body={"draft": False})
    if result["id"] != release_id or result["tag_name"] != tag or result["draft"] is not False:
        raise RuntimeError("GitHub did not confirm publication of the expected draft.")
    print(result["html_url"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--packages", type=Path)
    parser.add_argument("--publish-sha")
    args = parser.parse_args()
    assert_versions(args.tag)
    if args.publish_sha and args.packages is None:
        parser.error("--publish-sha requires --packages")
    if args.packages is not None:
        files = validate_packages(args.packages, args.tag)
        if args.publish_sha:
            publish_release(GitHubRelease(os.environ["GITHUB_REPOSITORY"]), args.tag, args.publish_sha, files)


if __name__ == "__main__":
    main()
