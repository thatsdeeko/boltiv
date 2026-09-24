const AGENT_API=window.BOLTIV_API_BASE;
const agentToken=()=>boltivMemoryStorage.getItem("boltivAuthToken")||"";
const agentHeaders=()=>({"Content-Type":"application/json",...(agentToken()?{Authorization:"Bearer "+agentToken()}: {})});
const money=v=>"₦"+Number(v||0).toLocaleString("en-NG",{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
async function agentFetch(path,opts={}){const r=await fetch(AGENT_API+path,{credentials:"include",cache:"no-store",...opts,headers:{...agentHeaders(),...(opts.headers||{})}});let d={};try{d=await r.json()}catch{};if(r.status===401){location.href="/login";throw new Error("Your session has expired.");}if(!r.ok||d.success===false)throw new Error(d.message||"Unable to complete the request.");return d;}
async function requireAgent(){try{const d=await agentFetch("/api/me");if(d.user?.accountType!=="agent"){location.href="/dashboard";return null;}return d;}catch(e){if(!location.pathname.includes("login"))setTimeout(()=>location.href="/dashboard",250);return null;}}
function agentNav(active){document.querySelectorAll(".agent-nav a").forEach(a=>a.classList.toggle("active",a.dataset.page===active));}
async function getPin(){if(typeof boltivGetTransactionPin!=="function")return null;return await boltivGetTransactionPin();}
function showAgentMessage(text,type="error"){const el=document.getElementById("agentMessage");if(!el)return;el.textContent=text;el.className="agent-message show "+type;}
