/** Serialized into the preview HTML. Never changes source, proxy URL or business data. */
export async function previewLoadGuard(options, start, { timeoutMs = 12000, retryDelayMs = 300 } = {}) {
  const key = 'forge-preview-load-retry:' + options.projectId;
  let rendered = false, interacted = false, bootDone = false, retrying = false, settled = false;
  let panel = null, loadingTimer, deadline, observer;
  const hasContent = () => {
    const root = document.getElementById('root');
    if (root) return root.childElementCount > 0 && (root.innerText.trim().length > 0
      || !!root.querySelector('canvas,svg,img,input,button,video'));
    return [...document.body.children].some(el => !['SCRIPT','STYLE','LINK'].includes(el.tagName)
      && !el.hasAttribute('data-forge-load-guard') && (el.textContent.trim() || el.matches('canvas,svg,img,input,button')));
  };
  const removePanel = () => { panel?.remove(); panel = null; };
  const showPanel = (text) => {
    if (!panel) {
      panel = document.createElement('section');panel.setAttribute('data-forge-load-guard','');panel.setAttribute('role','status');
      panel.style.cssText = 'position:fixed;inset:auto 16px 16px;z-index:2147483647;padding:16px;border:1px solid #cbd5e1;border-radius:10px;background:#f8fafc;color:#0f172a;font:14px/1.6 system-ui;box-shadow:0 4px 20px #0002';
      (document.body || document.documentElement).append(panel);
    }
    panel.replaceChildren();const message=document.createElement('p');message.style.margin='0';message.textContent=text;panel.append(message);
    return panel;
  };
  const ready = () => {
    if (!bootDone || retrying || !hasContent()) return;
    rendered = true;settled = true;clearTimeout(deadline);clearTimeout(loadingTimer);observer?.disconnect();removePanel();
    window.__forgePreviewLoadStatus = 'ready';
    try { sessionStorage.removeItem(key); } catch { /* Unavailable session storage disables auto retry. */ }
  };
  const prepareReload = () => {
    // A missing bridge guard is safe only before bootstrap has even begun importing App modules.
    if (typeof window.__forgeStoragePrepareReload === 'function') return window.__forgeStoragePrepareReload();
    return window.__forgePreviewPhase === undefined;
  };
  const problem = (error) => {
    if (retrying) return;
    clearTimeout(loadingTimer);clearTimeout(deadline);
    window.__forgePreviewLoadStatus = 'needs_attention';
    console.error('FORGE_PREVIEW_LOAD', String(error?.message || error).slice(0, 1000));
    const hostMismatch=String(error?.message||error).startsWith('APP_STORAGE_HOST_MISMATCH');
    let attempted = true;
    try { attempted = sessionStorage.getItem(key) === '1'; } catch { /* No persistent attempt marker: never auto retry. */ }
    if (!hostMismatch && !rendered && !interacted && !hasContent() && !attempted) {
      try {
        sessionStorage.setItem(key, '1'); // Persist before reload; persistent errors cannot create a refresh loop.
        if (prepareReload()) {
          retrying = true;window.__forgePreviewLoadStatus = 'retrying';
          showPanel('正在重新加载预览（仅自动尝试一次）…');
          setTimeout(() => location.reload(), retryDelayMs);return;
        }
      } catch { /* Fall back to an explicit user action, preserving all app data. */ }
    }
    const box=showPanel(hostMismatch ? '预览宿主地址与项目配置不一致。请从 Forge 打开预览；原数据未被修改。' : rendered ? '应用运行时出现待处理问题。已保存的应用数据保留，可以尝试重新加载预览。' : '预览暂未正常显示。已保存的应用数据保留，可以尝试重新加载预览。');
    const button=document.createElement('button');button.textContent=hostMismatch?'从 Forge 打开预览':'重新加载预览';button.type='button';
    button.style.cssText='margin-top:10px;padding:7px 14px;border:0;border-radius:6px;background:#2563eb;color:white;cursor:pointer';
    button.onclick=()=>{
      if(hostMismatch){window.open(options.hostOrigin+'/preview/'+encodeURIComponent(options.projectId),'_blank','noopener,noreferrer');return;}
      if (!prepareReload()) { box.firstChild.textContent='数据仍在保存或需要核对，暂未刷新。原数据保留，请稍后重试。';return; }
      location.reload();
    };box.append(button);
    const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');
    summary.textContent='加载诊断';pre.style.cssText='white-space:pre-wrap;max-height:140px;overflow:auto';pre.textContent=String(error?.message || error).slice(0,1000)+(hostMismatch?'\n'+JSON.stringify(window.__forgePreviewHost||{}):'');
    details.append(summary,pre);box.append(details);
  };
  for (const name of ['pointerdown','keydown','input']) window.addEventListener(name,()=>{interacted=true;},{capture:true,once:true});
  window.addEventListener('error',event=>{if(event.error)problem(event.error);});
  window.addEventListener('unhandledrejection',event=>problem(event.reason || '初始化异常'));
  loadingTimer=setTimeout(()=>{if(!rendered&&!retrying)showPanel('正在加载应用…');},1000);
  deadline=setTimeout(()=>{if(!settled)problem(new Error('PREVIEW_LOAD_TIMEOUT: 页面尚未完成显示'));},timeoutMs);
  observer=new MutationObserver(ready);observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  try { await start();bootDone=true;ready(); }
  catch(error) { problem(error); }
}
