(function(){
  'use strict';
  let deferredPrompt = null;
  const DISMISSED_KEY = 'boltiv_install_dismissed_at';
  const DISMISS_DAYS = 14;

  function isStandalone(){
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  function recentlyDismissed(){
    try {
      const value = Number(localStorage.getItem(DISMISSED_KEY) || 0);
      return value && (Date.now() - value) < DISMISS_DAYS * 86400000;
    } catch(e){ return false; }
  }
  // iOS Safari (and any other iOS browser, since they all use WebKit under
  // Apple's rules) never fires `beforeinstallprompt` — there is no
  // programmatic install API on iOS at all. Without this check, the entire
  // install prompt silently never appears for any iPhone/iPad user, which is
  // exactly the "doesn't pop up on some devices" symptom: it works fine on
  // Android Chrome/Edge and simply never fires on iOS.
  function isIOS(){
    const ua = window.navigator.userAgent || '';
    const iOSDevice = /iPad|iPhone|iPod/.test(ua);
    // iPadOS 13+ reports as "Macintosh" but exposes multi-touch, unlike a real Mac.
    const iPadOS13 = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    return iOSDevice || iPadOS13;
  }
  function isIOSSafari(){
    if(!isIOS()) return false;
    const ua = window.navigator.userAgent || '';
    // Every third-party iOS browser (Chrome, Firefox, Edge on iOS) is WebKit
    // underneath and identifies itself with CriOS/FxiOS/EdgiOS — only Safari
    // itself exposes the "Add to Home Screen" share-sheet action, so this
    // fallback only makes sense (and should only be shown) there.
    return !/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua);
  }
  function canShow(){
    return !isStandalone() && !recentlyDismissed() && !!deferredPrompt;
  }
  function canShowIOS(){
    return !isStandalone() && !recentlyDismissed() && isIOSSafari();
  }
  function createPrompt(){
    if(document.getElementById('boltiv-install-prompt')) return;
    const wrap = document.createElement('aside');
    wrap.id = 'boltiv-install-prompt';
    wrap.className = 'boltiv-install-prompt';
    wrap.setAttribute('aria-label','Install BOLTIV');
    wrap.innerHTML = '<div class="boltiv-install-copy"><div class="boltiv-install-title">Install BOLTIV</div><div class="boltiv-install-text">Get faster access to airtime, data, bills &amp; your wallet.</div></div><button class="boltiv-install-close" type="button" aria-label="Dismiss install prompt">×</button><button class="boltiv-install-action" type="button">Install App</button>';
    document.body.appendChild(wrap);
    wrap.querySelector('.boltiv-install-close').addEventListener('click', function(){
      try{ localStorage.setItem(DISMISSED_KEY, String(Date.now())); }catch(e){}
      wrap.classList.remove('is-visible');
      setTimeout(() => wrap.remove(), 220);
    });
    wrap.querySelector('.boltiv-install-action').addEventListener('click', async function(){
      if(!deferredPrompt) return;
      const prompt = deferredPrompt;
      deferredPrompt = null;
      prompt.prompt();
      try{ await prompt.userChoice; }catch(e){}
      wrap.classList.remove('is-visible');
      setTimeout(() => wrap.remove(), 220);
    });
    requestAnimationFrame(() => wrap.classList.add('is-visible'));
  }
  function createIOSPrompt(){
    if(document.getElementById('boltiv-install-prompt')) return;
    const wrap = document.createElement('aside');
    wrap.id = 'boltiv-install-prompt';
    wrap.className = 'boltiv-install-prompt boltiv-install-prompt-ios';
    wrap.setAttribute('aria-label','Install BOLTIV');
    wrap.innerHTML = '<div class="boltiv-install-copy"><div class="boltiv-install-title">Install BOLTIV</div><div class="boltiv-install-text">Tap <span class="boltiv-install-ios-icon" aria-hidden="true">'+
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>'+
      '</span> Share, then \u201cAdd to Home Screen\u201d.</div></div><button class="boltiv-install-close" type="button" aria-label="Dismiss install prompt">×</button>';
    document.body.appendChild(wrap);
    wrap.querySelector('.boltiv-install-close').addEventListener('click', function(){
      try{ localStorage.setItem(DISMISSED_KEY, String(Date.now())); }catch(e){}
      wrap.classList.remove('is-visible');
      setTimeout(() => wrap.remove(), 220);
    });
    requestAnimationFrame(() => wrap.classList.add('is-visible'));
  }
  function maybeShow(){
    if(!canShow()) return;
    setTimeout(createPrompt, 900);
  }
  window.addEventListener('beforeinstallprompt', function(event){
    event.preventDefault();
    deferredPrompt = event;
    maybeShow();
  });
  window.addEventListener('appinstalled', function(){
    deferredPrompt = null;
    const prompt = document.getElementById('boltiv-install-prompt');
    if(prompt) prompt.remove();
  });
  window.addEventListener('load', function(){
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }
    // Chromium browsers get here via the beforeinstallprompt listener above;
    // iOS Safari has no such event, so it needs its own trigger.
    if(canShowIOS()) setTimeout(createIOSPrompt, 900);
  });
})();
