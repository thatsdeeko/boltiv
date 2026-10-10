/* One orchestrated moment on the dashboard: the balance counts up once when it first loads. */
(function(){var el=document.getElementById('walletBalance');if(!el||matchMedia('(prefers-reduced-motion:reduce)').matches)return;var done=false;
new MutationObserver(function(){if(done)return;var v=parseFloat(el.textContent.replace(/[^0-9.]/g,''));if(!(v>0))return;done=true;var s=performance.now();
function f(n){return '\u20A6'+n.toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2})}
function t(now){var p=Math.min(1,(now-s)/900);el.textContent=f(v*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(t)}requestAnimationFrame(t)}).observe(el,{childList:true,characterData:true,subtree:true})})();
