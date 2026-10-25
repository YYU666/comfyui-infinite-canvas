import json
import urllib.request
from pathlib import Path

payload = {
    "idea": "图片里的女孩是唯一清晰展示的主角，视频只参考舞蹈动作。视频中的红色人物不要完整出现，只允许画面边缘露出他举着手机的一小部分。女孩跳完舞转身时撞到电线杆并倒下。竖屏，15 秒，不要配乐。",
    "currentPrompt": "@主角 是跳舞角色，@舞蹈参考 只提供动作。",
    "mode": "reference",
    "duration": 15,
    "ratio": "9:16",
    "references": [
        {"title": "主角", "kind": "image", "tag": "<Picture 1>", "slot": "references"},
        {"title": "舞蹈参考", "kind": "video", "tag": "<Video 1>", "slot": "references"},
    ],
}
request = urllib.request.Request(
    "http://127.0.0.1:8790/api/optimize-prompt",
    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=180) as response:
    result = json.load(response)
prompt = result.get("prompt", "")
required = [
    "subject_definitions:", "summary:", "retention_analysis:",
    "detailed_description:", "overall_soundscape:", "non_diegetic_music:",
]
assert all(section in prompt for section in required), prompt
assert "<Picture 1>" in prompt, prompt
assert "<Video 1>" in prompt, prompt
assert "<Picture 1>" not in prompt.split("detailed_description:", 1)[1], prompt
assert "N/A" in prompt, prompt
report = {"status": 200, "model": result.get("model"), "sections": required, "prompt": prompt}
Path("../prompt_api_test_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
