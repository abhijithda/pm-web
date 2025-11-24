(() => {
  const pluginsEl = document.getElementById('plugins');
  const form = document.getElementById('plugin-form');
  const startAllBtn = document.getElementById('start-all');
  const stopAllBtn = document.getElementById('stop-all');
  const exportBtn = document.getElementById('export');
  const importFile = document.getElementById('import-file');
  const clearFormBtn = document.getElementById('clear-form');
  const clearAllBtn = document.getElementById('clear-all');

  let plugins = [];

  function uid() { return Math.random().toString(36).slice(2,9); }

  // Try to locate an array of plugin definitions inside parsed documents.
  function extractPluginArray(doc){
    if (Array.isArray(doc)) return doc;
    if (doc && typeof doc === 'object') {
      const candidates = ['plugins','items','tasks','definitions','steps','entries','pre','pre_reboot','prereboot','pre-reboot','preupgrade','pre-upgrade','pre_upgrade'];
      const docKeys = Object.keys(doc || {});
      // case-insensitive match for common candidate keys
      for (const cand of candidates) {
        const match = docKeys.find(k => k.toLowerCase() === cand.toLowerCase());
        if (match && Array.isArray(doc[match])) return doc[match];
      }
      // look for nested arrays inside top-level values
      for (const v of Object.values(doc)) {
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
      }
      // If the doc is a map of pluginName -> pluginObject, convert to array (use Name if present)
      const values = Object.values(doc);
      const keys = Object.keys(doc);
      const allObjects = values.length > 0 && values.every(v => v && typeof v === 'object' && !Array.isArray(v));
      if (allObjects) {
        return keys.map(k => {
          const v = doc[k];
          return Object.assign({}, v, { name: v.name || v.Name || k });
        });
      }
      // try deeper: if there's an object containing plugin maps
      for (const v of values) {
        if (v && typeof v === 'object') {
          const nestedKeys = Object.keys(v || {});
          const nestedValues = Object.values(v || {});
          if (nestedValues.length > 0 && nestedValues.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
            return nestedKeys.map(k => Object.assign({}, v[k], { name: v[k].name || v[k].Name || k }));
          }
        }
      }
    }
    return null;
  }

  // Rewrite common GitHub blob URLs to raw.githubusercontent.com to avoid CORS HTML pages
  function rewriteGitHubUrl(url){
    try{
      const u = new URL(url);
      if((u.hostname === 'github.com' || u.hostname.endsWith('.github.com')) && u.pathname.includes('/blob/')){
        // path: /<owner>/<repo>/blob/<branch>/path/to/file
        const parts = u.pathname.split('/').filter(Boolean);
        // expect parts[0]=owner, [1]=repo, [2]=blob, [3]=branch, rest=path
        if(parts.length >= 4 && parts[2] === 'blob'){
          const owner = parts[0];
          const repo = parts[1];
          const branch = parts[3];
          const filePath = parts.slice(4).join('/');
          return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
        }
      }
    }catch(e){ /* ignore */ }
    return url;
  }

  // Normalize plugin shape: support alternate keys like cmd, requires, depends_on
  function normalizePlugin(item){
    // handle wrapper objects like { "pluginA": { ... } }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const keys = Object.keys(item);
      if ((!item.name && !item.Name && keys.length === 1) && item[keys[0]] && typeof item[keys[0]] === 'object') {
        const inner = item[keys[0]];
        item = Object.assign({}, inner);
        item.name = item.name || item.Name || keys[0];
      }
    }

    const name = item.name || item.Name || item.id || item.title || item.plugin || '';
    const description = item.description || item.Description || item.desc || item.summary || '';
    const command = item.command || item.Command || item.ExecStart || item.execStart || item.cmd || item.run || item.exec || '';
    let deps = item.dependencies || item.Dependencies || item.deps || item.Requires || item.requires || item.depends_on || item.after || [];
    if(typeof deps === 'string') deps = deps.split(',').map(s=>s.trim()).filter(Boolean);
    if(!Array.isArray(deps)) deps = [];
    return {name,description,command,deps};
  }

  function render() {
    pluginsEl.innerHTML = '';
    plugins.forEach(p => pluginsEl.appendChild(createPluginEl(p)));
  }

  function createPluginEl(p) {
    const el = document.createElement('div');
    el.className = 'plugin';

    const top = document.createElement('div'); top.className = 'top';
    const title = document.createElement('div');
    const name = document.createElement('div'); name.textContent = p.name || '(unnamed)';
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = p.command || '';
    title.appendChild(name); title.appendChild(meta);

    const right = document.createElement('div');
    const status = document.createElement('span'); status.className = `status ${p.status.toLowerCase()}`; status.textContent = p.status;
    right.appendChild(status);
    top.appendChild(title); top.appendChild(right);

    const desc = document.createElement('div'); desc.className = 'meta'; desc.textContent = p.description || '';

    const deps = document.createElement('div'); deps.className = 'meta'; deps.textContent = p.dependencies.length ? 'Depends: ' + p.dependencies.join(', ') : '';

    const progressWrap = document.createElement('div'); progressWrap.className = 'progress';
    const bar = document.createElement('i'); bar.style.width = p.progress + '%'; progressWrap.appendChild(bar);

    // simplified plugin card: no per-plugin action buttons (Start/Stop/Remove removed)
    el.appendChild(top);
    el.appendChild(desc);
    el.appendChild(deps);
    el.appendChild(progressWrap);

    return el;
  }

  function addPlugin({name,description,command,deps}){
    plugins.push({id:uid(),name,description,command,dependencies:deps||[],progress:0,status:'Pending',interval:null,waiting:false});
    render();
  }

  function tryStartPlugin(id){
    const p = plugins.find(x=>x.id===id); if(!p) return;
    if(p.status==='Running') return;
    // check dependencies by name
    const unmet = p.dependencies.filter(d => {
      const dep = plugins.find(x=>x.name === d.trim());
      return !dep || dep.status !== 'Success';
    });
    if(unmet.length){ p.status = 'Blocked'; p.waiting = true; render(); return; }
    startPlugin(p);
  }

  function startPlugin(p){
    p.status = 'Running'; p.waiting = false; p.progress = Math.max(0,p.progress);
    const duration = 3000 + Math.random()*7000; // 3-10s
    const start = Date.now();
    if(p.interval) clearInterval(p.interval);
    p.interval = setInterval(()=>{
      const elapsed = Date.now()-start;
      p.progress = Math.min(100, Math.round((elapsed/duration)*100));
      if(p.progress>=100){
        clearInterval(p.interval); p.interval = null;
        // failure small chance
        if(Math.random()<0.08){ p.status='Failed'; p.progress=100; }
        else { p.status='Success'; p.progress=100; }
        onPluginComplete(p);
      }
      render();
    },150);
    render();
  }

  function stopPlugin(id){
    const p = plugins.find(x=>x.id===id); if(!p) return;
    if(p.interval) clearInterval(p.interval); p.interval = null; p.status='Stopped'; render();
  }

  function startAll(){
    // attempt to start plugins, respecting dependencies; blocked ones will remain until deps finish
    plugins.forEach(p => {
      tryStartPlugin(p.id);
    });
    // try to start blocked plugins when deps complete
  }

  function stopAll(){
    plugins.forEach(p=>{ if(p.interval) clearInterval(p.interval); p.interval=null; if(p.status==='Running') p.status='Stopped'; }); render();
  }

  function onPluginComplete(p){
    // when any plugin completes successfully, try to start any waiting plugins whose dependencies are now satisfied
    plugins.forEach(q=>{
      if(q.waiting){
        const unmet = q.dependencies.filter(d => {
          const dep = plugins.find(x=>x.name === d.trim());
          return !dep || dep.status !== 'Success';
        });
        if(!unmet.length){ tryStartPlugin(q.id); }
      }
    });
  }

  function exportJSON(){
    const data = JSON.stringify(plugins.map(p=>({name:p.name,description:p.description,command:p.command,dependencies:p.dependencies})),null,2);
    const blob = new Blob([data],{type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='plugins.json'; a.click(); URL.revokeObjectURL(url);
  }

  function exportYAML(){
    if(typeof jsyaml === 'undefined'){ alert('YAML export unavailable'); return; }
    const payload = plugins.map(p=>({name:p.name,description:p.description,command:p.command,dependencies:p.dependencies}));
    const data = jsyaml.dump(payload);
    const blob = new Blob([data],{type:'text/yaml'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='plugins.yaml'; a.click(); URL.revokeObjectURL(url);
  }

  function importJSONorYAML(file){
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      const name = (file.name||'').toLowerCase();
      try{
        let doc;
        if(name.endsWith('.yaml') || name.endsWith('.yml')){
          if(typeof jsyaml === 'undefined'){ alert('YAML support not available'); return; }
          doc = jsyaml.load(text);
        } else {
          // try JSON first, then YAML
          try{ doc = JSON.parse(text); }
          catch(_){
            if(typeof jsyaml === 'undefined'){ alert('Unable to parse content and YAML support is not available'); return; }
            doc = jsyaml.load(text);
          }
        }

        const arr = extractPluginArray(doc);
        if(!arr){ alert('Imported document did not contain a plugin array'); return; }
        arr.forEach(item => addPlugin(normalizePlugin(item)));
      }catch(err){ console.error(err); alert('Invalid file format'); }
    };
    reader.readAsText(file);
  }

  // wire up form
  form.addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('name').value.trim();
    const description = document.getElementById('description').value.trim();
    const command = document.getElementById('command').value.trim();
    const deps = document.getElementById('dependencies').value.split(',').map(s=>s.trim()).filter(Boolean);
    addPlugin({name,description,command,deps});
    form.reset();
  });

  clearFormBtn.addEventListener('click', ()=>form.reset());
  startAllBtn.addEventListener('click', startAll);
  stopAllBtn.addEventListener('click', stopAll);
  exportBtn.addEventListener('click', exportJSON);
  const exportYamlBtn = document.getElementById('export-yaml');
  if(exportYamlBtn) exportYamlBtn.addEventListener('click', exportYAML);
  importFile.addEventListener('change', e => { if(e.target.files[0]) importJSONorYAML(e.target.files[0]); e.target.value=''; });

  const importUrlInput = document.getElementById('import-url');
  const previewBtn = document.getElementById('preview-btn');
  const importFromUrlBtn = document.getElementById('import-from-url-btn');
  const manualText = document.getElementById('manual-text');
  const importFileInput = document.getElementById('import-file');
  const sampleSelect = document.getElementById('sample-select');

  async function fetchAndImport(url){
    if(!url){ alert('Please provide a URL'); return; }
    url = rewriteGitHubUrl(url);
    console.info('Fetching URL:', url);
    try{
      const res = await fetch(url);
      if(!res.ok) { alert('Failed to fetch URL: ' + res.status + ' ' + res.statusText); return; }
      const ctype = (res.headers.get('content-type')||'').toLowerCase();
      const text = await res.text();
      let arr;
      const lower = url.split('?')[0].toLowerCase();
      if(lower.endsWith('.yaml') || lower.endsWith('.yml') || ctype.includes('yaml')){
        if(typeof jsyaml === 'undefined'){ alert('YAML support not available'); return; }
        arr = jsyaml.load(text);
      } else if(lower.endsWith('.json') || ctype.includes('json')){
        arr = JSON.parse(text);
      } else {
        // try JSON first, fall back to YAML
        try{ arr = JSON.parse(text); }
        catch(_){
          if(typeof jsyaml === 'undefined'){ alert('Unable to parse content and YAML support is not available'); return; }
          arr = jsyaml.load(text);
        }
      }
      const list = extractPluginArray(arr);
      if(!list){ alert('Remote document did not contain a plugin array'); return; }
      list.forEach(item => addPlugin(normalizePlugin(item)));
    }catch(err){
      console.error(err);
      alert('Error importing from URL. This may be due to CORS restrictions or a network error. See console for details.');
    }
  }

  async function fetchAndPreview(url){
    const previewEl = document.getElementById('import-preview');
    previewEl.innerHTML = '';
    if(!url){ alert('Please provide a URL'); return; }
    url = rewriteGitHubUrl(url);
    console.info('Preview fetch URL:', url);
    try{
      const res = await fetch(url);
      if(!res.ok) { alert('Failed to fetch URL: ' + res.status + ' ' + res.statusText); return; }
      const ctype = (res.headers.get('content-type')||'').toLowerCase();
      const text = await res.text();
      let arr;
      const lower = url.split('?')[0].toLowerCase();
      if(lower.endsWith('.yaml') || lower.endsWith('.yml') || ctype.includes('yaml')){
        if(typeof jsyaml === 'undefined'){ alert('YAML support not available'); return; }
        arr = jsyaml.load(text);
      } else if(lower.endsWith('.json') || ctype.includes('json')){
        arr = JSON.parse(text);
      } else {
        try{ arr = JSON.parse(text); }
        catch(_){ if(typeof jsyaml === 'undefined'){ alert('Unable to parse content and YAML support not available'); return; } arr = jsyaml.load(text); }
      }
      const list = extractPluginArray(arr);
      if(!list){ alert('Remote document did not contain a plugin array'); return; }
      // render preview (populate content; do not change panel visibility)
      list.forEach((it,idx)=>{
        const norm = normalizePlugin(it);
        const itemEl = document.createElement('div'); itemEl.className='item';
        const nameEl = document.createElement('div'); nameEl.className='name'; nameEl.textContent = norm.name || '(no name)';
        const rawEl = document.createElement('div'); rawEl.className='raw'; rawEl.textContent = JSON.stringify(it,null,2);
        itemEl.appendChild(nameEl); itemEl.appendChild(rawEl); previewEl.appendChild(itemEl);
      });
    }catch(err){ console.error(err); alert('Error previewing URL (CORS or network issue). See console for details.'); }
  }

  // Unified preview: manual text > selected file > URL
  async function previewCommon(){
    const previewEl = document.getElementById('import-preview');
    previewEl.innerHTML='';

    return new Promise(async (resolve, reject) => {
      const text = (manualText && manualText.value && manualText.value.trim()) || null;
      if(text){
        try{
          let doc;
          try{ doc = JSON.parse(text); }
          catch(_){ if(typeof jsyaml === 'undefined') throw new Error('YAML support not available'); doc = jsyaml.load(text); }
          const list = extractPluginArray(doc);
          if(!list) { alert('Pasted document did not contain a plugin array'); return reject(new Error('no-plugin-array')); }
          // populate preview content (do not auto-show the preview panel)
          list.forEach(it => { const norm = normalizePlugin(it); const itemEl = document.createElement('div'); itemEl.className='item'; const nameEl = document.createElement('div'); nameEl.className='name'; nameEl.textContent = norm.name || '(no name)'; const rawEl = document.createElement('div'); rawEl.className='raw'; rawEl.textContent = JSON.stringify(it,null,2); itemEl.appendChild(nameEl); itemEl.appendChild(rawEl); previewEl.appendChild(itemEl); });
          return resolve();
        }catch(err){ console.error(err); alert('Failed to parse pasted text'); return reject(err); }
      }

      // next: file input
      if(importFileInput && importFileInput.files && importFileInput.files[0]){
        const file = importFileInput.files[0];
        const reader = new FileReader();
        reader.onload = e => {
          try{
            const text = e.target.result;
            let doc;
            const name = (file.name||'').toLowerCase();
            if(name.endsWith('.yaml')||name.endsWith('.yml')){ if(typeof jsyaml==='undefined'){ alert('YAML support not available'); return reject(new Error('yaml-unavailable')); } doc = jsyaml.load(text); }
            else { try{ doc = JSON.parse(text); } catch(_){ if(typeof jsyaml==='undefined'){ alert('YAML support not available'); return reject(new Error('yaml-unavailable')); } doc = jsyaml.load(text); } }
            const list = extractPluginArray(doc);
            if(!list){ alert('File did not contain a plugin array'); return reject(new Error('no-plugin-array')); }
            // populate preview content (do not auto-show the preview panel)
            list.forEach(it => { const norm = normalizePlugin(it); const itemEl = document.createElement('div'); itemEl.className='item'; const nameEl = document.createElement('div'); nameEl.className='name'; nameEl.textContent = norm.name || '(no name)'; const rawEl = document.createElement('div'); rawEl.className='raw'; rawEl.textContent = JSON.stringify(it,null,2); itemEl.appendChild(nameEl); itemEl.appendChild(rawEl); previewEl.appendChild(itemEl); });
            return resolve();
          }catch(err){ console.error(err); alert('Failed to parse file'); return reject(err); }
        };
        reader.onerror = e => { console.error(e); alert('Failed to read file'); return reject(e); };
        reader.readAsText(file);
        return;
      }

      // finally: URL
      const url = importUrlInput && importUrlInput.value && importUrlInput.value.trim();
      if(url){
        try{
          await fetchAndPreview(url);
          return resolve();
        }catch(err){ return reject(err); }
      }
      alert('Provide pasted text, select a file, or enter a URL to preview');
      return reject(new Error('no-source'));
    });
  }

  async function importCommon(){
    // priority: manual text > file > url
    const text = (manualText && manualText.value && manualText.value.trim()) || null;
    if(text){
      try{ let doc; try{ doc = JSON.parse(text); } catch(_){ if(typeof jsyaml==='undefined') throw new Error('YAML support not available'); doc = jsyaml.load(text); } const list = extractPluginArray(doc); if(!list){ alert('Pasted document did not contain a plugin array'); return; } list.forEach(it => addPlugin(normalizePlugin(it))); return; }catch(err){ console.error(err); alert('Failed to parse pasted text'); return; }
    }
    if(importFileInput && importFileInput.files && importFileInput.files[0]){ importJSONorYAML(importFileInput.files[0]); return; }
    const url = importUrlInput && importUrlInput.value && importUrlInput.value.trim();
    if(url){ fetchAndImport(url); return; }
    alert('Provide pasted text, select a file, or enter a URL to import');
  }

  // View Details toggles visibility of the preview panel. Try a silent background preview first (no alerts).
  if(previewBtn) previewBtn.addEventListener('click', async ()=>{
    const globalPreview = document.getElementById('global-preview');
    if(!globalPreview) return;
    // run the background auto-preview function (which won't show alert when no source)
    try{ await autoPreviewIfPossible(); }catch(_){}
    // toggle panel visibility
    const isOpen = globalPreview.style.display === 'block';
    if(isOpen){ globalPreview.style.display = 'none'; previewBtn.textContent = 'View Details'; }
    else { globalPreview.style.display = 'block'; previewBtn.textContent = 'Hide Details'; }
  });
  if(importFromUrlBtn) importFromUrlBtn.addEventListener('click', async ()=>{
    try{
      await previewCommon();
    }catch(e){
      // preview failed or no source; still ask user if they want to continue
      if(!confirm('Preview failed or unavailable. Continue with import?')) return;
    }
    importCommon();
  });
  // removed Show Preview toggle — preview panel is shown when user clicks Preview
  // removed old "clear sample" control; provide a small helper to clear inputs if needed
  function clearImportInputs(){
    if(manualText) manualText.value = '';
    if(importFileInput) importFileInput.value = '';
    if(importUrlInput) importUrlInput.value = '';
    const importPreview = document.getElementById('import-preview'); if(importPreview) { importPreview.style.display='none'; importPreview.innerHTML=''; }
  }

  // Auto-update preview when import sources change (does not auto-show the preview panel)
  function debounce(fn, wait){ let t; return (...args)=>{ clearTimeout(t); t = setTimeout(()=>fn(...args), wait); }; }

  function hasSource(){
    if(manualText && manualText.value && manualText.value.trim()) return true;
    if(importFileInput && importFileInput.files && importFileInput.files[0]) return true;
    if(importUrlInput && importUrlInput.value && importUrlInput.value.trim()) return true;
    return false;
  }

  async function autoPreviewIfPossible(){
    if(!hasSource()){
      // nothing to preview: clear preview content
      const previewEl = document.getElementById('import-preview'); if(previewEl) previewEl.innerHTML = '';
      return;
    }
    try{ await previewCommon(); }catch(_){ /* ignore errors during background preview */ }
  }

  const debouncedAutoPreview = debounce(autoPreviewIfPossible, 450);
  if(importUrlInput) importUrlInput.addEventListener('input', ()=> debouncedAutoPreview());
  if(manualText) manualText.addEventListener('input', ()=> debouncedAutoPreview());
  if(importFileInput) importFileInput.addEventListener('change', ()=> debouncedAutoPreview());
  if(sampleSelect) sampleSelect.addEventListener('change', ()=>{ const key = sampleSelect.value; const url = getSampleUrl(key); if(importUrlInput) importUrlInput.value = url || ''; debouncedAutoPreview(); });

  // Sample URLs (GitHub blob or raw are both supported)
  const SAMPLE_PREREBOOT = 'https://raw.githubusercontent.com/abhijithda/plugin-manager/refs/heads/v1/sample/plugins-prereboot.json';
  const SAMPLE_PREUPGRADE = 'https://raw.githubusercontent.com/abhijithda/plugin-manager/refs/heads/v1/sample/plugins-preupgrade.yaml';

  function getSampleUrl(key){
    if(key === 'prereboot') return SAMPLE_PREREBOOT;
    if(key === 'preupgrade') return SAMPLE_PREUPGRADE;
    return '';
  }

  // (sampleSelect change listener is wired above to auto-populate and auto-preview)

  function clearAll(){
    if(!confirm('Remove all plugins and stop any running tasks?')) return;
    plugins.forEach(p=>{ if(p.interval) clearInterval(p.interval); p.interval = null; });
    plugins = [];
    render();
  }

  if(clearAllBtn) clearAllBtn.addEventListener('click', clearAll);

  // initial render (start with an empty list)
  render();
})();
