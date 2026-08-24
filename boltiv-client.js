/* BOLTIV client security layer. Auth uses an HttpOnly cookie, with a
   localStorage-backed bearer token as a fallback for browsers/devices that
   block cross-site cookies between boltiv.ng and the Render backend. */
(function(){
  let persistentStorageOk=true;
  const mem=new Map();
  try{
    const testKey='__boltiv_test__';
    window.localStorage.setItem(testKey,'1');
    window.localStorage.removeItem(testKey);
  }catch(e){ persistentStorageOk=false; }
  // Seed the in-memory cache from localStorage so the token survives page navigation.
  if(persistentStorageOk){
    try{
      for(let i=0;i<window.localStorage.length;i++){
        const k=window.localStorage.key(i);
        if(k&&k.indexOf('boltiv')===0) mem.set(k,window.localStorage.getItem(k));
      }
    }catch(e){}
  }
  window.boltivMemoryStorage={
    getItem(k){ return mem.has(k)?mem.get(k):null; },
    setItem(k,v){
      mem.set(String(k),String(v));
      if(persistentStorageOk){ try{ window.localStorage.setItem(String(k),String(v)); }catch(e){} }
    },
    removeItem(k){
      mem.delete(String(k));
      if(persistentStorageOk){ try{ window.localStorage.removeItem(String(k)); }catch(e){} }
    },
    clear(){
      mem.clear();
      if(persistentStorageOk){ try{ window.localStorage.clear(); }catch(e){} }
    },
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
    if(!u){ location.replace('/login'); return null; }

    // Every authenticated area except Security requires a Transaction PIN.
    // New users are sent to Security to create one before they can use BOLTIV.
    const path=(location.pathname||'/').replace(/\/$/,'')||'/';
    const exemptPaths=['/security','/login','/register','/forgot-password','/reset-password','/verify-email'];
    if(!exemptPaths.includes(path)){
      try{
        const api=window.BOLTIV_API_BASE || 'https://boltiv-backend.onrender.com';
        const r=await nativeFetch(api+'/api/security',{credentials:'include',cache:'no-store'});
        const d=await r.json().catch(()=>({}));
        if(r.ok && d.success && !d.transactionPinSet){
          location.replace('/security?setup=required');
          return null;
        }
      }catch(e){
        // Do not block access solely because the status check failed.
        // Purchase endpoints independently require a valid Transaction PIN.
      }
    }
    return u;
  };
})();
