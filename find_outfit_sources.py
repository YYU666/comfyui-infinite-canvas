import json
from urllib.request import urlopen

targets = {'H3_OutfitHD_bl_00002_.png', 'H3_OutfitHD_br_00005_.png'}
with urlopen('http://127.0.0.1:8188/history?max_items=40') as response:
    history = json.load(response)
for prompt_id, entry in history.items():
    graph = entry.get('prompt', [None, None, {}])[2]
    for output in entry.get('outputs', {}).values():
        for image in output.get('images', []):
            if image.get('filename') in targets:
                print(json.dumps({'promptId': prompt_id, 'output': image['filename'], 'source': graph.get('source', {}).get('inputs', {}).get('image')}, ensure_ascii=False))
