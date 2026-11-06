"""Render the actual graph route over the supplied diagram for human review."""
import json
import pathlib
import subprocess
from PIL import Image, ImageDraw, ImageFont

root = pathlib.Path(__file__).resolve().parents[2]
source = r"""
const fs=require('node:fs'),vm=require('node:vm'); const c=vm.createContext({window:{}});
for(const f of ['geography.js','world-data.js'])vm.runInContext(fs.readFileSync('assets/js/'+f,'utf8'),c);
const G=c.window.RPHubGeography,W=c.window.RPHubWorlds['jiangnan-south-campus'];
console.log(JSON.stringify({world:W,path:G.path(W,'dorm-13','lab-A','walk'),walk:G.route(W,'dorm-13','lab-A'),bike:G.route(W,'dorm-13','lab-A',{mode:'bike'}),dorm:G.route(W,'dorm-3','dorm-13')}));
"""
data = json.loads(subprocess.run(['node', '-'], input=source.encode('utf-8'), cwd=root, stdout=subprocess.PIPE, check=True).stdout.decode('utf-8'))
world = data['world']
base = Image.open(root / world['image']).convert('RGBA').resize(tuple(world['imageSize']), Image.Resampling.LANCZOS)
canvas = Image.new('RGBA', (1610, base.height), 'white')
canvas.paste(base, (0, 0))
overlay = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
draw = ImageDraw.Draw(overlay)
points = {p['id']: tuple(p['point']) for p in world['places']}
places = {p['id']: p for p in world['places']}
for e in world['edges']:
    draw.line([points[e['from']], *[tuple(p) for p in e.get('points', [])], points[e['to']]], fill=(18, 121, 145, 100), width=4)
for e in data['path']['edges']:
    draw.line([points[e['from']], *[tuple(p) for p in e.get('points', [])], points[e['to']]], fill=(205, 33, 100, 230), width=10)
font_path = pathlib.Path('C:/Windows/Fonts/msyh.ttc')
font = ImageFont.truetype(str(font_path), 25)
small = ImageFont.truetype(str(font_path), 22)
title = ImageFont.truetype(str(font_path), 34)
for i, node in enumerate(data['path']['nodes'], 1):
    x, y = points[node]
    draw.ellipse((x-19, y-19, x+19, y+19), fill=(205, 33, 100, 255), outline='white', width=3)
    draw.text((x, y), str(i), font=small, fill='white', anchor='mm')
canvas = Image.alpha_composite(canvas, overlay).convert('RGB')
draw = ImageDraw.Draw(canvas)
x = 1120
draw.text((x, 50), '江大南校区路线核对', font=title, fill='#202020')
draw.text((x, 120), '13栋 → 实验楼A区', font=font, fill='#202020')
draw.text((x, 170), '紫红：本次实际计算的步行路线', font=small, fill='#cd2164')
draw.text((x, 210), '蓝色：试点道路网络', font=small, fill='#127991')
walk = data['walk']['duration']
bike = data['bike']['duration']
lines = [f"正常步行：约{walk['typicalMinutes']}分钟", f"估算范围：{walk['rangeMinutes'][0]}—{walk['rangeMinutes'][1]}分钟", f"骑车模型：约{bike['typicalMinutes']}分钟", '骑车结果含找车/停车，尚未实测。', '位置与道路来自图片人工判读。', '用户红线路线约35分钟作为标定。', '不是GPS，也不是现实校园测绘。', '室内上下楼与等待需另外计时。', '', '实际路径节点：']
y = 285
for line in lines:
    draw.text((x, y), line, font=small, fill='#303030'); y += 43
for i, node in enumerate(data['path']['nodes'], 1):
    draw.text((x, y), f"{i}. {places[node]['name']}", font=small, fill='#303030'); y += 43
draw.text((x, y + 50), '桥/隧道/近路的可通行性可继续校准。', font=small, fill='#303030')
output = root / 'docs/geography-pilot-route.png'
canvas.save(output)
print(output)
print(json.dumps({k:data[k]['duration'] for k in ['walk','bike','dorm']}))
