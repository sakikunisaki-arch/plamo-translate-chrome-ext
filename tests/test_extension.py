#!/usr/bin/env python3
"""
PLaMo Translate Chrome 拡張機能の静的整合性テストおよび LM Studio 実機スモークテスト。

使い方:
  python3 tests/test_extension.py                 # 静的・構造テストのみ
  python3 tests/test_extension.py --live-lmstudio # 実機 LM Studio スモークテストも実行
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def read_text(rel_path: str) -> str:
    path = ROOT / rel_path
    assert_true(path.exists(), f"Missing file: {rel_path}")
    return path.read_text(encoding="utf-8")


def parse_png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert_true(data[:8] == b"\x89PNG\r\n\x1a\n", f"Invalid PNG signature: {path}")
    assert_true(data[12:16] == b"IHDR", f"Missing IHDR chunk: {path}")
    width, height = struct.unpack("!II", data[16:24])
    return width, height


def test_manifest_and_assets() -> None:
    manifest = json.loads(read_text("manifest.json"))
    assert_true(manifest.get("manifest_version") == 3, "manifest_version must be 3")

    perms = set(manifest.get("permissions", []))
    for required_perm in ("sidePanel", "storage", "activeTab", "scripting", "contextMenus"):
        assert_true(required_perm in perms, f"Missing permission: {required_perm}")

    host_perms = manifest.get("host_permissions", [])
    assert_true(
        any("localhost" in h for h in host_perms) and any("127.0.0.1" in h for h in host_perms),
        "host_permissions must include localhost and 127.0.0.1",
    )

    # Background service worker
    bg = manifest.get("background", {})
    assert_true(bg.get("type") == "module", "Service worker must be ES module")
    assert_true((ROOT / bg["service_worker"]).is_file(), f"Missing SW: {bg['service_worker']}")

    # Side panel
    sp_path = manifest.get("side_panel", {}).get("default_path")
    assert_true(bool(sp_path) and (ROOT / sp_path).is_file(), f"Missing side_panel: {sp_path}")

    # Icons
    expected_sizes = {"16": 16, "48": 48, "128": 128}
    for key, expected in expected_sizes.items():
        icon_rel = manifest.get("icons", {}).get(key)
        assert_true(bool(icon_rel), f"Missing icon {key}")
        icon_path = ROOT / icon_rel
        assert_true(icon_path.is_file(), f"Missing icon file: {icon_rel}")
        w, h = parse_png_dimensions(icon_path)
        assert_true((w, h) == (expected, expected), f"Icon {icon_rel} size {w}x{h} != {expected}x{expected}")

        action_icon_rel = manifest.get("action", {}).get("default_icon", {}).get(key)
        assert_true(action_icon_rel == icon_rel, f"Action icon mismatch for {key}")

    # Content scripts
    cs_list = manifest.get("content_scripts", [])
    assert_true(len(cs_list) >= 1, "content_scripts must be defined")
    for cs in cs_list:
        for js_file in cs.get("js", []):
            assert_true((ROOT / js_file).is_file(), f"Missing content js: {js_file}")
        for css_file in cs.get("css", []):
            assert_true((ROOT / css_file).is_file(), f"Missing content css: {css_file}")


def test_sidepanel_references_and_safety() -> None:
    html = read_text("src/sidepanel/sidepanel.html")
    sp_dir = ROOT / "src/sidepanel"

    for match in re.finditer(r'(?:src|href)=["\']([^"\']+)["\']', html):
        ref = match.group(1)
        if ref.startswith(("http://", "https://", "#")):
            continue
        assert_true((sp_dir / ref).is_file(), f"Broken reference in sidepanel.html: {ref}")

    assert_true('<script type="module" src="sidepanel.js"></script>' in html, "sidepanel.js must be loaded as module")

    sp_js = read_text("src/sidepanel/sidepanel.js")
    assert_true("innerHTML" not in sp_js, "sidepanel.js must not use innerHTML")

    # Verify all getElementById IDs exist in sidepanel.html
    html_ids = set(re.findall(r'id=["\']([^"\']+)["\']', html))
    js_ids = set(re.findall(r'getElementById\(["\']([^"\']+)["\']\)', sp_js))
    missing_ids = js_ids - html_ids
    assert_true(not missing_ids, f"IDs referenced in sidepanel.js missing from HTML: {missing_ids}")


def test_content_script_constraints() -> None:
    content_js = read_text("src/content/content.js")
    assert_true(not re.search(r"^\s*(import|export)\b", content_js, re.MULTILINE), "content.js must not contain import/export")
    assert_true("__plamoTranslateLoaded" in content_js, "content.js must have double-injection guard")
    for forbidden in ("innerHTML", "outerHTML", "insertAdjacentHTML"):
        assert_true(forbidden not in content_js, f"content.js must not use {forbidden}")

    # Validate JS syntax via macOS JavaScriptCore (osascript) if available
    if shutil.which("osascript"):
        script = (
            "ObjC.import('Foundation');"
            "var str = $.NSString.stringWithContentsOfFileEncodingError("
            f"'{ROOT / 'src/content/content.js'}', $.NSUTF8StringEncoding, null);"
            "new Function(ObjC.unwrap(str)); 'OK';"
        )
        proc = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", script],
            capture_output=True,
            text=True,
            check=False,
        )
        assert_true(proc.returncode == 0, f"content.js syntax check failed: {proc.stderr}")


def test_message_contracts() -> None:
    sw_js = read_text("src/background/service-worker.js")
    content_js = read_text("src/content/content.js")
    sp_js = read_text("src/sidepanel/sidepanel.js")
    constants_js = read_text("src/shared/constants.js")

    assert_true("plamo-stream" in constants_js, "PORT_NAME 'plamo-stream' missing in constants.js")

    for msg_type in (
        "CHECK_CONNECTION",
        "PAGE_ACTION",
        "GET_PENDING_SELECTION",
        "TRANSLATE_TEXT",
        "ABORT_TAB_TRANSLATION",
        "PAGE_PROGRESS",
        "CONTENT_PAGE_ACTION",
        "SELECTION_FOR_SIDEPANEL",
        "PAGE_PROGRESS_UPDATE",
    ):
        found = (msg_type in sw_js) and ((msg_type in content_js) or (msg_type in sp_js))
        assert_true(found, f"Message contract '{msg_type}' not wired consistently")

    # Verify chrome.sidePanel.open is called synchronously in contextMenus.onClicked before any await
    ctx_match = re.search(r"chrome\.contextMenus\.onClicked\.addListener\(([\s\S]+?)\n\}\);", sw_js)
    assert_true(bool(ctx_match), "contextMenus.onClicked listener not found")
    ctx_body = ctx_match.group(1)
    open_pos = ctx_body.find("chrome.sidePanel.open")
    await_pos = ctx_body.find("await ")
    assert_true(open_pos != -1, "chrome.sidePanel.open must be called in contextMenus.onClicked")
    assert_true(await_pos == -1 or open_pos < await_pos, "chrome.sidePanel.open must precede any await")

    # Verify prompt constants
    assert_true("[plamo-translate]" in constants_js, "[plamo-translate] header missing")
    assert_true("<|plamo:tag|>" in constants_js and "<|plamo:bos|>" in constants_js, "Stop sequences missing")


def post_chat_completion(base_url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def test_live_lmstudio(base_url: str, model: str) -> None:
    print(f"[Live] Checking models at {base_url}/v1/models ...")
    with urllib.request.urlopen(f"{base_url}/v1/models", timeout=10) as resp:
        models_json = json.loads(resp.read().decode("utf-8"))
    model_ids = [m.get("id") for m in models_json.get("data", []) if isinstance(m, dict)]
    assert_true(model in model_ids, f"Target model '{model}' not found in loaded models: {model_ids}")
    print(f"  Loaded models: {model_ids}")

    # 1. Polite mode
    res_polite = post_chat_completion(
        base_url,
        {
            "model": model,
            "messages": [
                {"role": "system", "content": "[plamo-translate]\ntarget_lang=ja\nform=polite"},
                {"role": "user", "content": "Please check your connection settings."},
            ],
            "temperature": 0.0,
            "max_tokens": 256,
            "stop": ["<|plamo:tag|>", "<|plamo:bos|>"],
            "stream": False,
        },
    )
    polite_text = res_polite["choices"][0]["message"]["content"].strip()
    print(f"  [Polite] {polite_text}")
    assert_true(len(polite_text) > 0 and "<|plamo:" not in polite_text, "Invalid polite translation output")

    # 2. Plain mode
    res_plain = post_chat_completion(
        base_url,
        {
            "model": model,
            "messages": [
                {"role": "system", "content": "[plamo-translate]\ntarget_lang=ja\nform=plain"},
                {"role": "user", "content": "The server started successfully."},
            ],
            "temperature": 0.0,
            "max_tokens": 256,
            "stop": ["<|plamo:tag|>", "<|plamo:bos|>"],
            "stream": False,
        },
    )
    plain_text = res_plain["choices"][0]["message"]["content"].strip()
    print(f"  [Plain]  {plain_text}")
    assert_true(len(plain_text) > 0 and "<|plamo:" not in plain_text, "Invalid plain translation output")

    # 3. Glossary
    res_glossary = post_chat_completion(
        base_url,
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "[plamo-translate]\ntarget_lang=ja\nform=polite\nglossary=dashboard => 管理画面",
                },
                {"role": "user", "content": "Open the dashboard to review your settings."},
            ],
            "temperature": 0.0,
            "max_tokens": 256,
            "stop": ["<|plamo:tag|>", "<|plamo:bos|>"],
            "stream": False,
        },
    )
    glossary_text = res_glossary["choices"][0]["message"]["content"].strip()
    print(f"  [Glossary] {glossary_text}")
    assert_true("管理画面" in glossary_text, f"Glossary term '管理画面' not applied: {glossary_text}")

    # 4. Streaming SSE
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps(
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": "[plamo-translate]\ntarget_lang=ja\nform=polite"},
                    {"role": "user", "content": "Local translation keeps your data private."},
                ],
                "temperature": 0.0,
                "max_tokens": 256,
                "stop": ["<|plamo:tag|>", "<|plamo:bos|>"],
                "stream": True,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    chunks = []
    saw_done = False
    with urllib.request.urlopen(req, timeout=30) as resp:
        for raw_line in resp:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                saw_done = True
                break
            data = json.loads(payload)
            delta = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
            if delta:
                chunks.append(delta)

    streamed = "".join(chunks).strip()
    print(f"  [Stream] ({len(chunks)} chunks) {streamed}")
    assert_true(saw_done, "SSE stream did not terminate with [DONE]")
    assert_true(len(streamed) > 0 and "<|plamo:" not in streamed, f"Invalid streamed output: {streamed}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live-lmstudio", action="store_true", help="Run live smoke tests against LM Studio")
    parser.add_argument("--base-url", default="http://localhost:1234", help="LM Studio base URL")
    parser.add_argument("--model", default="plamo-3-translate-2b", help="Model ID to test")
    args = parser.parse_args()

    tests = [
        ("manifest & assets", test_manifest_and_assets),
        ("sidepanel references & safety", test_sidepanel_references_and_safety),
        ("content script constraints", test_content_script_constraints),
        ("message contracts", test_message_contracts),
    ]

    for name, fn in tests:
        fn()
        print(f"PASS: {name}")

    if args.live_lmstudio:
        test_live_lmstudio(args.base_url.rstrip("/"), args.model)
        print("PASS: live LM Studio smoke tests")

    return 0


if __name__ == "__main__":
    sys.exit(main())
