/** Exercise the public panel API and host effects in an isolated Electron renderer. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { removeTree } from "../helpers/tmp.ts";
const RUN_TIMEOUT_MS = 30_000;
const root = process.cwd(),
  out = path.join(root, ".studio-dev/customization-ui");
await mkdir(out, { recursive: true });
await rm(path.join(out, "report.json"), { force: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-customization-ui-"));
await build({
  entryPoints: [path.join(root, "tests/e2e/plugin-customization-fixture.tsx")],
  outfile: path.join(out, "fixture.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${path.join(root, "dist/renderer/theme.css")}"><div id="root"></div><script type="module" src="fixture.js"></script>`,
);
const sdk = await readFile(path.join(root, "src/plugin-sdk/panel.js"), "utf8");
const theme = {
  version: 1,
  mode: "dark",
  fonts: { uiFont: "system", contentFont: "serif", codeFont: "system" },
  light: { background: "#102030", foreground: "#f5f5f5", accent: "#798fff" },
  dark: { background: "#102030", foreground: "#f5f5f5", accent: "#798fff" },
  geometry: { textSize: 16, buttonRadius: 4, cardRadius: 20 },
  surfaces: {
    newChat: { kind: "gradient", colors: ["#112233", "#334455"], animated: true },
    profile: { kind: "gradient", colors: ["#223355", "#553322"] },
  },
  layout: [
    {
      target: "navigation",
      columns: 2,
      gap: 12,
      items: {
        newGame: { column: 1, row: 1 },
        plugins: { column: 2, row: 1 },
        settings: { column: 1, row: 2, columnSpan: 2, height: 48 },
      },
    },
  ],
  widgets: [
    { id: "clock", kind: "clock", target: "newChat", label: "Local time", columnSpan: 4, rowSpan: 16 },
    {
      id: "weather",
      kind: "weather",
      target: "newChat",
      label: "Weather",
      text: "Cloudy, 18 °C",
      column: 5,
      columnSpan: 4,
      rowSpan: 16,
    },
    { id: "custom", kind: "panel", target: "newChat", panel: "widget", column: 9, columnSpan: 4, rowSpan: 16 },
  ],
};
const panel = `<!doctype html><meta charset="utf-8"><style>body{background:#15181c;color:#eee;font:14px system-ui;padding:20px}button{font:inherit;padding:10px;margin:6px;cursor:pointer}</style><h2>Disposable SDK test</h2><button id="apply">Apply</button><button id="reset">Reset</button><button id="invalid">Invalid</button><pre id="result"></pre><script>${sdk}</script><script>
const show=async(fn)=>{try{await fn();result.textContent='ok'}catch(e){result.textContent=e.message}};
document.querySelector('#apply').onclick=()=>show(()=>studioPlugin.call('customization.set',undefined,${JSON.stringify(theme)}));
document.querySelector('#reset').onclick=()=>show(()=>studioPlugin.call('customization.reset'));
document.querySelector('#invalid').onclick=()=>show(()=>studioPlugin.call('customization.set',undefined,{version:1,css:'body{display:none}'}));
</script>`;
const widgetPanel = `<!doctype html><meta charset="utf-8"><style>body{margin:8px;font:14px system-ui;background:#15181c;color:#eee}</style><div>Custom plugin UI</div><script>${sdk}</script>`;
await writeFile(
  path.join(out, "check.cjs"),
  String.raw`
const{app,BrowserWindow,protocol}=require('electron');const fs=require('node:fs');const{setTimeout:sleep}=require('node:timers/promises');
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile, "session"))});
protocol.registerSchemesAsPrivileged([{scheme:'studio-plugin',privileges:{standard:true,secure:true}}]);
const checks=[];function check(name,ok){checks.push({name,ok});console.log(name);if(!ok)throw new Error(name)}
async function until(fn){const end=Date.now()+5000;while(Date.now()<end){if(await fn())return;await sleep(25);}throw new Error('Fixture condition timed out')}
app.whenReady().then(async()=>{
console.log('Electron ready');
protocol.handle('studio-plugin',request=>new Response(request.url.endsWith('/widget')?${JSON.stringify(widgetPanel)}:${JSON.stringify(panel)},{headers:{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"}}));
const win=new BrowserWindow({width:1000,height:850,show:false,x:-4000,focusable:false,skipTaskbar:true,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});win.showInactive();const wc=win.webContents, errors=[];
wc.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
const js=code=>wc.executeJavaScript(code,true);
try{
await win.loadFile(${JSON.stringify(path.join(out, "index.html"))});
console.log('Fixture loaded');
await until(()=>js('!!document.querySelector("#native-control")'));
let frame;await until(async()=>{frame=wc.mainFrame.frames.find(f=>f.url.startsWith('studio-plugin:'));return !!frame});
await until(()=>frame.executeJavaScript('!!window.studioPlugin'));
check('opaque panel has no preload or Node',await frame.executeJavaScript('!window.studio && !window.require && !window.process && self.origin === "null"'));
check('feature discovery',await frame.executeJavaScript("studioPlugin.call('context').then(c=>c.features.uiCustomization===1)"));
const ordinary=await js('getComputedStyle(document.documentElement).getPropertyValue("--background")'),saved=await js('localStorage.getItem("studio.appearance.v1")');
const radius=await js('getComputedStyle(document.querySelector("#native-control")).borderRadius');
await frame.executeJavaScript('document.querySelector("#apply").click()');
await until(()=>js('getComputedStyle(document.documentElement).getPropertyValue("--background")==="#102030"'));
check('native controls use font size and radius',await js('getComputedStyle(document.querySelector("#native-control")).borderRadius==="4px" && getComputedStyle(document.querySelector("#native-control")).fontSize==="16px"'));
check('mode and native font choices apply',await js('document.documentElement.dataset.theme==="dark" && getComputedStyle(document.documentElement).getPropertyValue("--font-family-content").includes("Georgia")'));
check('native navigation uses the requested grid and button height',await js('getComputedStyle(document.querySelector("[data-customization-slot=navigation]")).display==="grid" && getComputedStyle(document.querySelector("#settings-control")).height==="48px" && getComputedStyle(document.querySelector("#settings-control")).gridColumnEnd==="span 2"'));
check('new chat has an animated gradient',await js('getComputedStyle(document.querySelector("#new-chat")).backgroundImage.includes("linear-gradient") && getComputedStyle(document.querySelector("#new-chat")).animationName==="studio-customization-background"'));
check('account card has a banner',await js('getComputedStyle(document.querySelector("[data-customization-slot=profile]")).backgroundImage.includes("linear-gradient") && document.querySelector("[data-customization-slot=profile]").getBoundingClientRect().height>=160'));
await until(()=>js('!!document.querySelector("[data-customization-widget=clock] time")'));
check('clock and plugin-supplied weather occupy grid slots',await js('!!document.querySelector("[data-customization-widget=clock] time") && document.querySelector("[data-customization-widget=weather]").textContent.includes("18 °C")'));
let widget;await until(async()=>{widget=wc.mainFrame.frames.find(f=>f.url.endsWith('/widget'));return !!widget});
check('custom widget retains opaque isolation and its own SDK bridge',await widget.executeJavaScript("!window.studio && !window.require && self.origin==='null' && !!window.studioPlugin") && await widget.executeJavaScript("studioPlugin.call('customization.read').then(p=>p.version===1 && p.widgets.some(w=>w.id==='custom'))"));
check('ordinary preference is unchanged',await js('localStorage.getItem("studio.appearance.v1")')===saved);
await js('window.testSheet=document.querySelector("style[data-plugin-customization]")');await js('customizationFixture.refresh()');
check('unchanged refresh preserves the style node',await js('testSheet===document.querySelector("style[data-plugin-customization]")'));
await frame.executeJavaScript('document.querySelector("#invalid").click()');await until(()=>frame.executeJavaScript('document.querySelector("#result").textContent.includes("Invalid")'));
check('invalid profile has no effect',await js('getComputedStyle(document.documentElement).getPropertyValue("--background")==="#102030"'));
wc.debugger.attach('1.3');await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
check('background animation respects reduced motion',await js('getComputedStyle(document.querySelector("#new-chat")).animationName==="none"'));
await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
await js('document.querySelector("#native-control").focus()');wc.sendInputEvent({type:'keyDown',keyCode:'Tab'});wc.sendInputEvent({type:'keyUp',keyCode:'Tab'});await sleep(25);
check('native navigation remains keyboard accessible',await js('document.activeElement.id==="plugins-control"'));
fs.writeFileSync(${JSON.stringify(path.join(out, "customized.png"))},(await wc.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
const raster=await js('(()=>{const c=document.createElement("canvas");c.width=2;c.height=2;c.getContext("2d").fillRect(0,0,2,2);return c.toDataURL("image/png")})()');
const pictureProfile=${JSON.stringify(theme)};pictureProfile.surfaces.newChat={kind:'image',data:raster,animated:true};pictureProfile.widgets.push({id:'banner-picture',kind:'image',target:'profile',image:raster,columnSpan:12,rowSpan:24});
await frame.executeJavaScript("studioPlugin.call('customization.set',undefined,"+JSON.stringify(pictureProfile)+")");
await until(()=>js('!!document.querySelector("[data-customization-widget=banner-picture] img") && document.querySelector("[data-customization-widget=banner-picture] img").naturalWidth===2'));
check('embedded image backgrounds and banners render without external requests',await js('getComputedStyle(document.querySelector("#new-chat")).backgroundImage.includes("data:image/png")'));
await js('customizationFixture.account(false)');await until(()=>js('!document.querySelector("[data-customization-slot=profile]")'));
await js('customizationFixture.account(true)');await until(()=>js('document.querySelector("[data-customization-widget=banner-picture] img")?.naturalWidth===2'));
check('widgets follow account-anchor unmount and remount',true);
pictureProfile.surfaces.newChat={kind:'glow',colors:['#3344ff','#ff3388'],animated:true};await frame.executeJavaScript("studioPlugin.call('customization.set',undefined,"+JSON.stringify(pictureProfile)+")");
await until(()=>js('getComputedStyle(document.querySelector("#new-chat")).backgroundImage.includes("radial-gradient")'));
check('glow background applies through generated host CSS',true);
await js('customizationFixture.enable(false)');await until(async()=>await js('getComputedStyle(document.documentElement).getPropertyValue("--background")')===ordinary);
check('disable removes widgets, banner, grid and stylesheet',await js('!document.querySelector("[data-customization-widget]") && !document.querySelector("style[data-plugin-customization]") && getComputedStyle(document.querySelector("[data-customization-slot=profile]")).backgroundImage==="none"'));
await frame.executeJavaScript('document.querySelector("#apply").click()');await until(()=>frame.executeJavaScript('document.querySelector("#result").textContent.includes("capability")'));
check('disabled panel cannot edit',await js('getComputedStyle(document.documentElement).getPropertyValue("--background")')===ordinary);
await js('customizationFixture.enable(true)');await until(()=>js('getComputedStyle(document.documentElement).getPropertyValue("--background")==="#102030"'));
check('re-enable restores the saved profile',true);
await frame.executeJavaScript('document.querySelector("#reset").click()');await until(async()=>await js('getComputedStyle(document.documentElement).getPropertyValue("--background")')===ordinary);
check('reset restores native geometry and clears the profile',await js('customizationFixture.profile()===null && !document.querySelector("[data-customization-widget]")') && await js('getComputedStyle(document.querySelector("#native-control")).borderRadius')===radius);
check('no renderer errors',errors.length===0);
}catch(error){checks.push({name:'runner completed',ok:false,error:String(error.stack)});}
fs.writeFileSync(${JSON.stringify(path.join(out, "report.json"))},JSON.stringify({checks,errors,provider:'fixture',electron:process.versions.electron},null,2));win.destroy();app.exit(checks.some(c=>!c.ok)?1:0);
});
`,
);
const child = spawn(resolveElectron(), fixtureElectronArgs([path.join(out, "check.cjs")]), {
  env: fixtureElectronEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (data) => process.stdout.write(data));
child.stderr.on("data", (data) => process.stderr.write(data));
const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
try {
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  for (const check of report.checks)
    console.log(`${check.ok ? "✔" : "✖"} ${check.name}${check.error ? `: ${check.error}` : ""}`);
  if (code !== 0) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await removeTree(profile);
}
