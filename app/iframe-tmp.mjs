import { chromium } from '@playwright/test';
const b = await chromium.launch({ executablePath:'/tmp/chrtest/chr/chromium',
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-sandbox'] });
for (const [label,w,h] of [['panel 520x400',520,400], ['wide 1280x800',1280,800]]) {
  const p = await b.newPage({ viewport:{width:w,height:h} });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  await p.setContent(`<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe src="http://localhost:7777/"></iframe>`);
  let boot='TIMEOUT', rows='-', fps='-';
  try {
    const f = await (await p.waitForSelector('iframe')).contentFrame();
    await f.waitForFunction(()=>document.querySelector('#boot')?.classList.contains('gone'),{timeout:45000});
    await p.waitForTimeout(1500);
    boot='ok'; rows=await f.textContent('#fRows'); fps=await f.textContent('#fFps');
  } catch(e){ boot=e.message.slice(0,80); }
  console.log(`  ${label}  boot=${boot}  rows=${rows}  fps=${fps}  errors=${errs.length?errs.slice(0,2).join(' | '):'NONE'}`);
  if (w>1000) await p.screenshot({ path:'shots/iframe-preview.png' });
  await p.close();
}
await b.close();
