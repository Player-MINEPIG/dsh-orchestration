"""Noncanonical QA projection of the exact delivered inline SVG; never a browser/export proof."""
import hashlib,json,re,subprocess,os
from pathlib import Path
ROOT=Path(__file__).resolve().parent
NAMES=['original','target','task-lifecycle','report-lifecycle']
manifest={'kind':'noncanonical-static-svg-inspection','renderer':'Inkscape 1.4','browserProof':False,'officialExport':False,'derivations':[]}
for name in NAMES:
 html=ROOT/name/(name+'.html');raw=html.read_bytes();doc=raw.decode()
 css=re.search(r'<style>([\s\S]*?)</style>',doc).group(1)
 svg=re.search(r'<svg\b[\s\S]*?</svg>',doc).group(0)
 css=re.sub(r'/\*[\s\S]*?\*/','',css)
 classes=set(c for group in re.findall(r'class="([^"]+)"',svg) for c in group.split())
 dark=re.search(r':root,\s*\[data-theme="dark"\]\s*\{([^}]+)\}',css).group(1)
 light=re.search(r'\[data-theme="light"\]\s*\{([^}]+)\}',css).group(1)
 font=re.search(r'\bsvg\s*\{[^}]*font-family:([^;]+);',css).group(1)
 for theme in ['light','dark']:
  variables=dict(re.findall(r'(--[\w-]+):\s*([^;]+);',dark+(light if theme=='light' else '')))
  rules=[]
  for selector,body in re.findall(r'([^{}]+)\{([^{}]*)\}',css):
   selector=selector.strip()
   if 'html' in selector or '@' in selector:continue
   if any(re.search(r'\.'+re.escape(c)+r'(?![\w-])',selector) for c in classes):rules.append(selector+'{'+body+'}')
  # Inherit the actual SVG font stack and classic grid-off declaration. HTML Viewer chrome/shadows are deliberately excluded.
  rules.insert(0,'svg{font-family:'+font+';}')
  rules.append('.c-grid{stroke:transparent;}')
  style='\n'.join(rules)
  def resolve_css(text):
   for _ in range(4):text=re.sub(r'var\((--[\w-]+)(?:,\s*([^)]*))?\)',lambda m:variables.get(m.group(1),m.group(2) or 'inherit'),text)
   # SVG 1.1-compatible equivalent; Inkscape does not paint CSS rgba() fills faithfully.
   text=re.sub(r'(fill|stroke)\s*:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([.\d]+)\s*\)\s*;',lambda m:f'{m[1]}:rgb({m[2]},{m[3]},{m[4]});{m[1]}-opacity:{m[5]};',text)
   return text
  result=resolve_css(svg)
  result=result.replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" ',1)
  start=result.index('>')+1
  result=result[:start]+'<style><![CDATA['+resolve_css(style)+']]></style>'+result[start:]
  folder=ROOT/'static-inspection'/name;folder.mkdir(parents=True,exist_ok=True)
  svgpath=folder/(theme+'.derived.svg');svgpath.write_text(result)
  entry={'diagram':name,'theme':theme,'sourceHtml':str(html.relative_to(ROOT)),'sourceSha256':hashlib.sha256(raw).hexdigest(),'derivedSvg':str(svgpath.relative_to(ROOT)),'pngs':[]}
  env=os.environ.copy();env['INKSCAPE_PROFILE_DIR']=str(ROOT/'static-inspection'/'.inkscape-profile')
  background='#ffffff' if theme=='light' else '#090f21'
  for width in [1440,2048]:
   output=folder/(theme+f'-{width}.png')
   command=['inkscape',str(svgpath),'--export-type=png','--export-area-page',f'--export-width={width}',f'--export-background={background}','--export-background-opacity=1',f'--export-filename={output}']
   r=subprocess.run(command,env=env,capture_output=True,text=True)
   (folder/(theme+f'-{width}.log')).write_text(r.stdout+r.stderr)
   entry['pngs'].append({'path':str(output.relative_to(ROOT)),'width':width,'exitCode':r.returncode,'sha256':hashlib.sha256(output.read_bytes()).hexdigest() if output.exists() else None})
   if r.returncode:raise SystemExit(r.stderr[-2000:])
  manifest['derivations'].append(entry)
(ROOT/'static-inspection'/'derivation-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'projections':len(manifest['derivations']),'pngs':sum(len(x['pngs']) for x in manifest['derivations']),'sourceHtmlUnchanged':all(hashlib.sha256((ROOT/x['sourceHtml']).read_bytes()).hexdigest()==x['sourceSha256'] for x in manifest['derivations'])}))
