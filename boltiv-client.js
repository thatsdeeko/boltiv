/* BOLTIV client security layer. Auth uses an HttpOnly cookie. */
(function(){
  const mem=new Map();
  function readCookie(name){ const m=document.cookie.match(new RegExp('(?:^|; )'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;]*)')); return m?decodeURIComponent(m[1]):null; }
  const sessionCookie=readCookie('boltiv_session');
  if(sessionCookie) mem.set('boltivAuthToken',sessionCookie);
  window.boltivMemoryStorage={
    getItem(k){ return mem.has(k)?mem.get(k):null; },
    setItem(k,v){ mem.set(String(k),String(v)); },
    removeItem(k){ mem.delete(String(k)); },
    clear(){ mem.clear(); },
    key(i){ return Array.from(mem.keys())[i] ?? null; },
    get length(){ return mem.size; }
  };
  const nativeFetch=window.fetch.bind(window);
  window.fetch=function(input,init){
    init=init||{};
    if(!Object.prototype.hasOwnProperty.call(init,'credentials')) init.credentials='include';
    return nativeFetch(input,init);
  };
  window.boltivAuthReady=(async function(){
    try{
      const api=window.BOLTIV_API_BASE || 'https://boltiv-backend.onrender.com';
      const r=await nativeFetch(api+'/api/auth/me',{credentials:'include',cache:'no-store'});
      const d=await r.json().catch(()=>({}));
      if(r.ok && d.success && d.user){
        mem.set('boltivUser',JSON.stringify(d.user));
        if(d.user.email) mem.set('boltivUserEmail',d.user.email);
        mem.set('boltivLoggedIn','true');
        return d.user;
      }
      // Fallback for deployments where the Render domain cannot persist a cross-site HttpOnly cookie.
      const token=mem.get('boltivAuthToken');
      if(token){
        const rr=await nativeFetch(api+'/api/me',{credentials:'include',headers:{Authorization:'Bearer '+token},cache:'no-store'});
        const dd=await rr.json().catch(()=>({}));
        if(rr.ok && dd.success && dd.user){
          mem.set('boltivUser',JSON.stringify(dd.user));
          if(dd.user.email) mem.set('boltivUserEmail',dd.user.email);
          mem.set('boltivLoggedIn','true');
          return dd.user;
        }
      }
    }catch(e){}
    return null;
  })();
  window.boltivRequireAuth=async function(){
    const u=await window.boltivAuthReady;
    if(!u){ location.replace('/login.html'); return null; }
    return u;
  };
})();
