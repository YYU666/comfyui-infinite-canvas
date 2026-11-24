"""Create the Pixal3D workflow variant that derives roughness from its UV atlas."""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / 'workflows' / 'pixal3d_lamp_shade_api.json'
    graph = json.loads(source.read_text(encoding='utf-8-sig'))
    graph['material_finish'] = {'class_type': 'RefmuseTextureToPBR', 'inputs': {
        'image': ['project_color', 0], 'normal_strength': 1.0, 'roughness': 0.62,
    }}
    graph['materials']['inputs']['roughness'] = ['material_finish', 3]
    graph['save_high_glb']['inputs']['filename_prefix'] = 'H3/extensions/chest-pbr'
    args.output.write_text(json.dumps(graph, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
