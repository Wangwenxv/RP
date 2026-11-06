"""Generate a readable current-source campus catalog and the conversation atlas."""
from pathlib import Path
import argparse, json, base64, io
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
world = json.loads((ROOT / 'worlds/jiangnan-south-campus.json').read_text(encoding='utf-8'))
source_image = ROOT / world['image']
with Image.open(source_image) as picture:
    picture = picture.convert('RGB')
    picture = picture.resize((800, round(800 * world['imageSize'][1] / world['imageSize'][0])))
    output = io.BytesIO()
    picture.save(output, format='JPEG', quality=78, optimize=True)
image_data = 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode('ascii')
inline_world = {k: world[k] for k in ('name', 'imageSize', 'districts', 'places', 'culture')}
encoded = json.dumps(inline_world, ensure_ascii=False, separators=(',', ':')).replace('<', r'\u003c')
fragment = (ROOT / 'tools/geography/campus-atlas-fragment.html').read_text(encoding='utf-8')
fragment = fragment.replace('__IMAGE__', image_data).replace('__DATA_JSON__', encoded)
assert len(fragment.encode('utf-8')) < 1024 * 1024, 'Inline atlas exceeds 1MB'
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(fragment, encoding='utf-8')

ordinary = [p for p in world['places'] if p['kind'] != 'junction']
nodes = [p for p in world['places'] if p['kind'] == 'junction']
lines = ['# 江大南校区 · 当前地点与完整介绍', '',
         f"来源：`worlds/jiangnan-south-campus.json`。{len(ordinary)}个场景地点、{len(nodes)}个路网节点、{len(world['edges'])}条道路。", '',
         '这是RP世界设定与示意图标注。每个地点的独立介绍与所属片区背景分开列出；没有补造数据中不存在的房间或设施。', '',
         '可视化入口：导航菜单 → 地图与地理环境 → 江大地图 → **浏览地点**。', '', '## 共享世界文化', '']
lines.extend('- ' + item for item in world.get('culture', []))
for district_id, district in world['districts'].items():
    places = [p for p in ordinary if p.get('district') == district_id]
    lines += ['', f"## {district.get('label', district_id)}（{len(places)}个场景地点）", '', '**片区完整背景**', '', district.get('scene', '尚未填写'), '']
    if district.get('source'):
        lines += ['来源：' + district['source'], '']
    for p in places:
        lines += [f"### {p['name']}", '', '**别名**：' + ('、'.join(p.get('aliases', [])) or '未设置'), '',
                  '**用途 / 功能**：' + (p.get('function') or '尚未填写'), '', '**地点完整介绍**', '',
                  p.get('scene') or '尚无独立介绍；继承本节顶部片区背景。', '']
        if p.get('access'):
            labels = {'open': '开放', 'close': '关闭', 'check': '查寝', 'sessions': '开放时段', 'restriction': '进入限制', 'note': '说明'}
            lines += ['**开放 / 通行规则**', '']
            for key, value in p['access'].items():
                lines.append('- ' + labels.get(key, key) + '：' + ('、'.join(map(str, value)) if isinstance(value, list) else str(value)))
            lines.append('')
        lines += [f"地图坐标：({p['point'][0]}, {p['point'][1]})；地点ID：`{p['id']}`。", '']
lines += ['## 路网连接节点（仅用于寻路）', '', '这些节点没有独立建筑介绍。名称、片区归属和坐标按当前源数据列出。', '', '| 节点 | 数据中的片区 | 功能 | 坐标 |', '| --- | --- | --- | --- |']
for p in nodes:
    district_name = world['districts'].get(p.get('district'), {}).get('label', p.get('district', ''))
    lines.append(f"| {p['name']} | {district_name} | {p.get('function') or '道路连接'} | {p['point'][0]}, {p['point'][1]} |")
catalog = ROOT / 'docs/jiangnan-campus-catalog.md'
catalog.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(json.dumps({'atlas': str(args.output), 'bytes': len(fragment.encode('utf-8')), 'catalog': str(catalog), 'places': len(ordinary), 'nodes': len(nodes)}, ensure_ascii=False))
