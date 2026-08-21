/* BOLTIV UI POLISH — presentation only. No API calls or backend logic. */
(function(){
  'use strict';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ready(){
    document.body.classList.add('boltiv-page-ready');
    requestAnimationFrame(function(){ document.body.classList.add('boltiv-loaded'); });
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once:true});
  else ready();
  window.addEventListener('load', function(){ document.body.classList.add('boltiv-loaded'); }, {once:true});

  // Smooth page-to-page transition without changing navigation or backend behaviour.
  if(!reduce){
    document.addEventListener('click', function(e){
      const target = e.target.closest('a[href], button[data-page]');
      if(!target || e.defaultPrevented) return;
      if(target.closest('.modal,.boltiv-modal,.coming-modal,.history-modal')) return;
      if(target.tagName === 'A' && (target.target === '_blank' || target.hasAttribute('download'))) return;
      const href = target.dataset.page || target.getAttribute('href');
      if(!href || href.charAt(0)==='#' || href.startsWith('javascript:')) return;
      if(/^https?:\/\//i.test(href) && !href.startsWith(location.origin)) return;
      document.body.classList.add('boltiv-navigating');
    }, true);
  }

  // Small tactile ripple on primary interactive controls.
  document.addEventListener('pointerdown', function(e){
    if(reduce) return;
    const control = e.target.closest('button,.btn,.home-service-card,.wallet-action,.action,.provider-card,.network-button,.amount-button,.filter-button');
    if(!control || control.disabled || control.classList.contains('ripple-host')) return;
    control.classList.add('ripple-host');
    const rect = control.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'boltiv-ripple';
    const size = Math.max(rect.width, rect.height) * 1.25;
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size/2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size/2) + 'px';
    control.appendChild(ripple);
    setTimeout(function(){ ripple.remove(); control.classList.remove('ripple-host'); }, 520);
  }, true);

  // Keep bottom navigation visually consistent on pages that already expose data-page buttons.
  const path = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('.bottom-nav .nav-item[data-page]').forEach(function(item){
    const page = item.dataset.page;
    if(page === path || (path === '/' && page === '/dashboard')) item.classList.add('active');
  });
})();
