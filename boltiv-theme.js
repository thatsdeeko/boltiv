(function(){
  const KEY='boltiv-theme';
  const root=document.documentElement;
  let saved;
  try{saved=localStorage.getItem(KEY)}catch(e){}
  // BOLTIV defaults to the normal/light theme. A saved choice is shared by every page on the same domain.
  const theme=saved==='light'||saved==='dark'?saved:'light';
  root.setAttribute('data-theme',theme);
  root.style.colorScheme=theme;

  function applyTheme(next, persist){
    const theme=next==='dark'?'dark':'light';
    root.setAttribute('data-theme',theme);
    root.style.colorScheme=theme;
    if(persist){try{localStorage.setItem(KEY,theme)}catch(e){}}
    updateMeta();
    const button=document.querySelector('.boltiv-theme-toggle');
    if(button){
      const icon=button.querySelector('.theme-icon');
      if(icon) icon.textContent=theme==='dark'?'☀':'☾';
      button.setAttribute('aria-label',theme==='dark'?'Switch to light mode':'Switch to dark mode');
      button.title=theme==='dark'?'Switch to light mode':'Switch to dark mode';
    }
  }

  function updateMeta(){
    const current=root.getAttribute('data-theme')==='dark'?'dark':'light';
    let meta=document.querySelector('meta[name="theme-color"]');
    if(!meta){meta=document.createElement('meta');meta.name='theme-color';document.head.appendChild(meta)}
    meta.content=current==='dark'?'#090909':'#ffffff';
  }

  function mount(){
    updateMeta();
    if(document.querySelector('.boltiv-theme-toggle')) return;
    const button=document.createElement('button');
    button.type='button';
    button.className='boltiv-theme-toggle';
    button.setAttribute('aria-label',theme==='dark'?'Switch to light mode':'Switch to dark mode');
    button.title=theme==='dark'?'Switch to light mode':'Switch to dark mode';
    button.innerHTML='<span class="theme-icon" aria-hidden="true">'+(theme==='dark'?'☀':'☾')+'</span>';
    button.addEventListener('click',function(){
      const next=root.getAttribute('data-theme')==='dark'?'light':'dark';
      applyTheme(next,true);
    });
    const host=document.querySelector('.top')||document.querySelector('.header');
    if(host){
      button.classList.add('inside-header');
      host.appendChild(button);
    }else{
      document.body.appendChild(button);
    }
  }
  // Keep multiple open BOLTIV tabs/windows synchronized. Every page uses the same key.
  window.addEventListener('storage',function(event){
    if(event.key===KEY && (event.newValue==='light'||event.newValue==='dark')) applyTheme(event.newValue,false);
  });

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
