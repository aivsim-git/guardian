/* app.js — polished mobile-first behavior
   - Button press => ensure permission => read location => start live-tracking => dial + WhatsApp
   - Start/Stop live-tracking toggle
   - Settings, permission guidance, confirm modal, QR/share
   - Optional Firebase (paste firebaseConfig into index.html)
*/

document.addEventListener('DOMContentLoaded', () => {
  // DOM refs
  const btnPolice = document.getElementById('btnPolice');
  const btnFire = document.getElementById('btnFire');
  const btnFamily = document.getElementById('btnFamily');

  const trackToggle = document.getElementById('trackToggle');
  const openMapBtn = document.getElementById('openMap');
  const shareMapBtn = document.getElementById('shareMap');

  const statusText = document.getElementById('statusText');
  const toastBox = document.getElementById('toast');

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const closeSettings = document.getElementById('closeSettings');
  const inputPolice = document.getElementById('inputPolice');
  const inputFire = document.getElementById('inputFire');
  const inputFamily = document.getElementById('inputFamily');
  const saveContacts = document.getElementById('saveContacts');
  const testSms = document.getElementById('testSms');

  const userNameInput = document.getElementById('userName');
  const saveName = document.getElementById('saveName');

  const permModal = document.getElementById('permModal');
  const permRetry = document.getElementById('permRetry');
  const permOpenSettings = document.getElementById('permOpenSettings');
  const permCancel = document.getElementById('permCancel');

  const confirmModal = document.getElementById('confirmModal');
  const confirmText = document.getElementById('confirmText');
  const confirmSend = document.getElementById('confirmSend');
  const confirmCancel = document.getElementById('confirmCancel');

  const qrModal = document.getElementById('qrModal');
  const qrcode = document.getElementById('qrcode');
  const copyLink = document.getElementById('copyLink');
  const closeQr = document.getElementById('closeQr');

  // State
  let firebaseAvailable = false;
  let db = null;
  let trackingInterval = null;
  let sessionId = null;
  let pressed = { blue:false, red:false, yellow:false };
  let isTracking = false;

  // Optional Firebase init
  try {
    if (typeof firebaseConfig === 'object' && firebaseConfig.apiKey && firebaseConfig.databaseURL) {
      if (!window.firebase?.apps?.length) firebase.initializeApp(firebaseConfig);
      if (firebase && firebase.database) {
        db = firebase.database();
        firebaseAvailable = true;
        console.info('Firebase ready for live-tracking.');
      }
    }
  } catch (e) {
    console.warn('Firebase init failed:', e);
    firebaseAvailable = false;
  }

  // Helpers: UI
  function toast(msg, ms = 3000){
    if(!toastBox) { console.log(msg); return; }
    toastBox.textContent = msg;
    toastBox.classList.remove('hidden');
    clearTimeout(toastBox._t);
    toastBox._t = setTimeout(()=> toastBox.classList.add('hidden'), ms);
  }
  function setStatus(msg){ if(statusText) statusText.textContent = msg; }
  function safeGet(k){ return localStorage.getItem(k) || ''; }

  // Permission helpers
  async function getPermissionState(){
    if(!navigator.permissions || !navigator.permissions.query) return null;
    try { const p = await navigator.permissions.query({ name: 'geolocation' }); return p.state; }
    catch(e){ return null; }
  }
  function requestGeolocationPrompt(options = { enableHighAccuracy:true, timeout:15000 }){
    return new Promise((resolve,reject) => {
      if(!navigator.geolocation) return reject(new Error('Geolocation not supported'));
      navigator.geolocation.getCurrentPosition(pos => resolve(pos.coords), err => reject(err), options);
    });
  }
  async function waitForPermissionChange(timeoutMs = 60000){
    const start = Date.now();
    return new Promise((resolve) => {
      const check = async () => {
        const s = await getPermissionState();
        if(s === 'granted') return resolve(true);
        if(Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 1500);
      };
      check();
    });
  }
  function showPermissionModal(show, message){
    if(!permModal) return;
    const msgEl = document.getElementById('permMsg');
    if(message && msgEl) msgEl.textContent = message;
    if(show) { permModal.classList.remove('hidden'); permModal.setAttribute('aria-hidden','false'); }
    else { permModal.classList.add('hidden'); permModal.setAttribute('aria-hidden','true'); }
  }
  function tryOpenBrowserSettings(){
    // Best-effort - may be blocked on many devices
    const urls = ['chrome://settings/content/location', 'edge://settings/content/location', 'about:preferences#privacy'];
    for(const u of urls){ try { window.open(u, '_blank'); return true; } catch(e){} }
    try { window.open('https://support.google.com/chrome/answer/142065?hl=en', '_blank'); } catch(e){}
    return false;
  }

  async function ensureLocationPermission({ maxWaitMs = 120000 } = {}){
    const state = await getPermissionState();
    if(state === 'granted') return true;

    if(state === 'prompt' || state === null){
      try {
        await requestGeolocationPrompt({ enableHighAccuracy:true, timeout:15000 });
        return true;
      } catch(e){
        console.warn('Prompt dismissed or failed', e);
      }
    }

    showPermissionModal(true, 'Location permission is blocked. Please enable Location for this site and press Retry.');
    return new Promise(async (resolve) => {
      const onRetry = async () => {
        showPermissionModal(false);
        const s = await getPermissionState();
        if(s === 'granted'){ cleanup(); return resolve(true); }
        try { await requestGeolocationPrompt({ enableHighAccuracy:true, timeout:15000 }); cleanup(); return resolve(true); }
        catch(e){ showPermissionModal(true, 'Still blocked. Open Settings then Retry.'); }
      };
      const onOpenSettings = () => tryOpenBrowserSettings();
      const onCancel = () => { cleanup(); resolve(false); };

      function cleanup(){
        permRetry.removeEventListener('click', onRetry);
        permOpenSettings.removeEventListener('click', onOpenSettings);
        permCancel.removeEventListener('click', onCancel);
        showPermissionModal(false);
      }

      permRetry.addEventListener('click', onRetry);
      permOpenSettings.addEventListener('click', onOpenSettings);
      permCancel.addEventListener('click', onCancel);

      const granted = await waitForPermissionChange(maxWaitMs);
      if(granted){ cleanup(); resolve(true); }
      // otherwise wait for user click
    });
  }

  async function getLocationWithPermission(options = { enableHighAccuracy:true, timeout:15000 }){
    const ok = await ensureLocationPermission();
    if(!ok) throw new Error('Location permission not granted');
    return await requestGeolocationPrompt(options);
  }

  // Compose message
  function composeMessage(label, lat, lon, liveUrl){
    const name = safeGet('guardian_name') || 'Unknown';
    const google = `https://maps.google.com/?q=${lat},${lon}`;
    const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
    let msg = `EMERGENCY: ${label}\nName: ${name}\nCoords: ${lat.toFixed(6)}, ${lon.toFixed(6)}\nGoogleMaps: ${google}\nOSM: ${osm}`;
    if(liveUrl) msg += `\nLive: ${liveUrl}`;
    msg += `\nTime: ${new Date().toLocaleString()}`;
    return msg;
  }

  // Dial & WhatsApp (wa.me fallback)
  function initiateCall(number){
    if(!number) return false;
    window.location.href = `tel:${encodeURIComponent(number)}`;
    return true;
  }
  function openWhatsApp(number, message){
    if(!number) return false;
    const normalized = number.replace(/[^+\d]/g, '');
    const encoded = encodeURIComponent(message);
    const appLink = `whatsapp://send?phone=${encodeURIComponent(normalized)}&text=${encoded}`;
    const webLink = `https://wa.me/${encodeURIComponent(normalized.replace(/^\+/,''))}?text=${encoded}`;
    try { window.location.href = appLink; } catch(e){}
    setTimeout(()=> { window.location.href = webLink; }, 1200);
    return true;
  }

  // Live-tracking logic
  function getSessionId(){
    let s = safeGet('guardian_session_id');
    if(!s){ s = Math.random().toString(36).slice(2,12); localStorage.setItem('guardian_session_id', s); }
    return s;
  }

  async function startLiveTrackingIfNeeded(coords){
    if(!sessionId) sessionId = getSessionId();
    if(firebaseAvailable && db){
      try{
        await db.ref(`tracks/${sessionId}/meta`).set({ name: safeGet('guardian_name') || 'Unknown', startedAt: new Date().toISOString() });
        await db.ref(`tracks/${sessionId}/latest`).set({ lat: coords.latitude, lon: coords.longitude, ts: new Date().toISOString(), name: safeGet('guardian_name') || 'Unknown' });
      } catch(e){ console.warn('firebase write failed', e); }
    }
    if(!trackingInterval){
      trackingInterval = setInterval(async () => {
        try {
          const c = await getLocationWithPermission();
          if(firebaseAvailable && db){
            await db.ref(`tracks/${sessionId}/latest`).set({ lat: c.latitude, lon: c.longitude, ts: new Date().toISOString(), name: safeGet('guardian_name') || 'Unknown' });
          } else {
            console.log('tracking (no firebase):', c);
          }
        } catch(e){ console.warn('tracking update failed', e); }
      }, 12000);
      isTracking = true;
      updateTrackingUI(true);
      setStatus('Live tracking active');
      toast('Live tracking started');
    }
  }

  function stopLiveTracking(){
    if(trackingInterval){ clearInterval(trackingInterval); trackingInterval = null; }
    isTracking = false;
    sessionId = null;
    updateTrackingUI(false);
    setStatus('Live tracking stopped');
    toast('Live tracking stopped');
  }

  async function toggleTrackingManual(){
    if(isTracking){ stopLiveTracking(); return; }
    try {
      setStatus('Obtaining location...');
      const coords = await getLocationWithPermission();
      await startLiveTrackingIfNeeded(coords);
    } catch(e){
      toast('Cannot start tracking: permission required');
      setStatus('Permission required');
    }
  }

  function updateTrackingUI(on){
    if(!trackToggle) return;
    if(on){
      trackToggle.classList.remove('start'); trackToggle.classList.add('stop'); trackToggle.textContent = 'Stop Live Tracking';
      [btnPolice, btnFire, btnFamily].forEach(b => { if(b) b.classList.add('pulsing'); if(b && !b.querySelector('.pulse-ring')){ const r = document.createElement('div'); r.className = 'pulse-ring'; b.appendChild(r); } });
      if(openMapBtn) openMapBtn.disabled = false;
      if(shareMapBtn) shareMapBtn.disabled = false;
    } else {
      trackToggle.classList.remove('stop'); trackToggle.classList.add('start'); trackToggle.textContent = 'Start Live Tracking';
      [btnPolice, btnFire, btnFamily].forEach(b => { if(b) b.classList.remove('pulsing'); const pr = b && b.querySelector('.pulse-ring'); if(pr) pr.remove(); });
      if(openMapBtn) openMapBtn.disabled = true;
      if(shareMapBtn) shareMapBtn.disabled = true;
    }
  }

  // Confirm helper
  function showConfirm(text){
    if(!confirmModal || !confirmSend || !confirmCancel) return Promise.resolve(window.confirm(text));
    confirmText.textContent = text;
    confirmModal.classList.remove('hidden');
    confirmModal.setAttribute('aria-hidden','false');
    return new Promise((resolve) => {
      confirmSend.onclick = () => { confirmModal.classList.add('hidden'); confirmModal.setAttribute('aria-hidden','true'); resolve(true); };
      confirmCancel.onclick = () => { confirmModal.classList.add('hidden'); confirmModal.setAttribute('aria-hidden','true'); resolve(false); };
    });
  }

  // Per-button micro UI: chip + micro reaction
  function setButtonChip(btn, text){
    if(!btn) return;
    let chip = btn.querySelector('.chip');
    if(!chip){ chip = document.createElement('span'); chip.className = 'chip'; btn.appendChild(chip); }
    chip.textContent = text;
  }
  function clearButtonChip(btn){ const c = btn && btn.querySelector('.chip'); if(c) c.remove(); }
  function microReact(btn){ if(!btn) return; btn.classList.add('reacted'); setTimeout(()=> btn.classList.remove('reacted'), 220); }

  // Main action flow for buttons
  async function handleAction(label){
    const map = { Police:'guardian_police', Fire:'guardian_fire', Family:'guardian_family' };
    const key = map[label];
    const number = localStorage.getItem(key) || '';
    if(!number){ toast(`No ${label} number set`); setStatus('No contact'); return; }

    setStatus('Checking location permission...');
    let coords;
    try {
      coords = await getLocationWithPermission();
    } catch(e){
      toast('Location permission required');
      setStatus('Permission denied');
      return;
    }

    await startLiveTrackingIfNeeded(coords);

    const liveUrl = (firebaseAvailable ? `${location.origin.replace(/\/$/,'')}/track.html?sid=${getSessionId()}` : null);
    const message = composeMessage(label, coords.latitude, coords.longitude, liveUrl);

    const ok = await showConfirm(`Call ${label} and open WhatsApp to send your location?`);
    if(!ok){ toast('Cancelled'); setStatus('Cancelled'); return; }

    const button = label === 'Police' ? btnPolice : label === 'Fire' ? btnFire : btnFamily;
    microReact(button);
    setButtonChip(button, 'Sent');

    initiateCall(number);
    setStatus(`Dialing ${label}...`);
    setTimeout(()=> { openWhatsApp(number, message); setStatus(`WhatsApp: messaging ${label}`); }, 900);

    if(label === 'Police') pressed.blue = true;
    if(label === 'Fire') pressed.red = true;
    if(label === 'Family') pressed.yellow = true;

    if(pressed.blue && pressed.red && pressed.yellow){
      const combined = composeMessage('ALL - Combined', coords.latitude, coords.longitude, liveUrl);
      try {
        if(navigator.share){ await navigator.share({ title:'Emergency', text:combined }); toast('Shared combined alert'); }
        else { await navigator.clipboard.writeText(combined); toast('Combined copied'); }
      } catch(e){ toast('Could not share combined alert'); }
    }

    setTimeout(()=> clearButtonChip(button), 6000);
  }

  // Compose helper + helpers for app links
  function composeMessage(label, lat, lon, liveUrl){
    const name = safeGet('guardian_name') || 'Unknown';
    const google = `https://maps.google.com/?q=${lat},${lon}`;
    const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`;
    let msg = `EMERGENCY: ${label}\nName: ${name}\nCoords: ${lat.toFixed(6)}, ${lon.toFixed(6)}\nGoogleMaps: ${google}\nOSM: ${osm}`;
    if(liveUrl) msg += `\nLive: ${liveUrl}`;
    msg += `\nTime: ${new Date().toLocaleString()}`;
    return msg;
  }
  function initiateCall(number){ if(!number) return false; window.location.href = `tel:${encodeURIComponent(number)}`; return true; }
  function openWhatsApp(number, message){
    if(!number) return false;
    const normalized = number.replace(/[^+\d]/g, '');
    const encoded = encodeURIComponent(message);
    const appLink = `whatsapp://send?phone=${encodeURIComponent(normalized)}&text=${encoded}`;
    const webLink = `https://wa.me/${encodeURIComponent(normalized.replace(/^\+/,''))}?text=${encoded}`;
    try { window.location.href = appLink; } catch(e) {}
    setTimeout(()=> { window.location.href = webLink; }, 1200);
    return true;
  }

  // Test message
  if(testSms) testSms.addEventListener('click', async () => {
    const num = inputFamily?.value || inputPolice?.value || inputFire?.value;
    if(!num){ toast('Set at least one number in Settings'); return; }
    try {
      const c = await getLocationWithPermission();
      const liveUrl = (firebaseAvailable ? `${location.origin.replace(/\/$/,'')}/track.html?sid=${getSessionId()}` : null);
      const msg = composeMessage('TEST', c.latitude, c.longitude, liveUrl);
      openWhatsApp(num, msg);
      toast('Opening WhatsApp to send test');
    } catch(e){
      toast('Could not get location for test');
    }
  });

  // Save/load settings
  if(saveContacts) saveContacts.addEventListener('click', () => {
    localStorage.setItem('guardian_police', inputPolice?.value.trim() || '');
    localStorage.setItem('guardian_fire', inputFire?.value.trim() || '');
    localStorage.setItem('guardian_family', inputFamily?.value.trim() || '');
    toast('Contacts saved');
    toggleModal(settingsModal, false);
  });
  if(saveName) saveName.addEventListener('click', () => {
    localStorage.setItem('guardian_name', userNameInput.value.trim());
    toast('Name saved');
  });

  // modal helpers
  function toggleModal(modal, show){
    if(!modal) return;
    if(show){ modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false'); }
    else { modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true'); }
  }

  if(settingsBtn) settingsBtn.addEventListener('click', () => {
    inputPolice && (inputPolice.value = safeGet('guardian_police'));
    inputFire && (inputFire.value = safeGet('guardian_fire'));
    inputFamily && (inputFamily.value = safeGet('guardian_family'));
    toggleModal(settingsModal, true);
  });
  if(closeSettings) closeSettings.addEventListener('click', () => toggleModal(settingsModal, false));

  // permission modal buttons handled inside ensureLocationPermission

  // Track toggle wiring
  if(trackToggle) {
    trackToggle.addEventListener('click', () => toggleTrackingManual());
    // initial state
    trackToggle.classList.add('track-toggle','start');
    trackToggle.textContent = 'Start Live Tracking';
  }

  // map/open/share
  if(openMapBtn) openMapBtn.addEventListener('click', () => {
    const sid = getSessionId();
    window.open(`${location.origin.replace(/\/$/,'')}/track.html?sid=${sid}`, '_blank');
  });
  if(shareMapBtn) shareMapBtn.addEventListener('click', async () => {
    const sid = getSessionId();
    const url = `${location.origin.replace(/\/$/,'')}/track.html?sid=${sid}`;
    if(navigator.share) {
      try { await navigator.share({ title:'Live location', text:'Live tracking link', url }); toast('Shared link'); }
      catch(e){ showQrModal(url); }
    } else showQrModal(url);
  });

  function showQrModal(url){
    if(!qrModal){ navigator.clipboard?.writeText(url).then(()=> toast('Link copied')); return; }
    qrcode.innerHTML = '';
    try {
      QRCode.toCanvas(url, { width:200 }, (err, canvas) => {
        if(err) qrcode.textContent = url;
        else qrcode.appendChild(canvas);
      });
    } catch(e) { qrcode.textContent = url; }
    toggleModal(qrModal, true);
  }
  if(closeQr) closeQr.addEventListener('click', () => toggleModal(qrModal, false));
  if(copyLink) copyLink.addEventListener('click', async () => {
    const sid = getSessionId();
    const url = `${location.origin.replace(/\/$/,'')}/track.html?sid=${sid}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch(e){ toast('Copy failed'); }
  });

  // Main action buttons
  if(btnPolice) btnPolice.addEventListener('click', () => handleAction('Police'));
  if(btnFire) btnFire.addEventListener('click', () => handleAction('Fire'));
  if(btnFamily) btnFamily.addEventListener('click', () => handleAction('Family'));

  // helpers
  function safeGet(k){ return localStorage.getItem(k) || ''; }
  function getSessionId(){ let s = safeGet('guardian_session_id'); if(!s){ s = Math.random().toString(36).slice(2,12); localStorage.setItem('guardian_session_id', s); } return s; }

  // init UI
  (function init(){
    inputPolice && (inputPolice.value = safeGet('guardian_police'));
    inputFire && (inputFire.value = safeGet('guardian_fire'));
    inputFamily && (inputFamily.value = safeGet('guardian_family'));
    userNameInput && (userNameInput.value = safeGet('guardian_name'));
    if(openMapBtn) openMapBtn.disabled = true;
    if(shareMapBtn) shareMapBtn.disabled = true;
    setStatus('Ready');
  })();

  // Expose small debug helpers
  window._guardian = {
    startLiveTracking: async () => { try { const c = await getLocationWithPermission(); await startLiveTrackingIfNeeded(c); } catch(e){ console.warn(e); } },
    stopLiveTracking
  };
});
