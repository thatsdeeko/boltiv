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
  function canShow(){
    return !isStandalone() && !recentlyDismissed() && !!deferredPrompt;
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
  });
})();
