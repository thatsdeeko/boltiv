/* BOLTIV shared transaction PIN modal. */
(function(){
  if(window.BoltivTransactionPin)return;
  const style=document.createElement('style');
  style.textContent=`
  .boltiv-pin-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(20,20,20,.55);backdrop-filter:blur(12px);opacity:0;visibility:hidden;transition:.2s}
  .boltiv-pin-overlay.show{opacity:1;visibility:visible}
  .boltiv-pin-card{width:100%;max-width:390px;box-sizing:border-box;padding:26px 22px 22px;border-radius:25px;background:linear-gradient(145deg,#fffdf4,#fff);border:1px solid #e5e5e1;box-shadow:0 30px 90px rgba(0,0,0,.55);text-align:center;transform:translateY(16px) scale(.97);transition:.22s}
  .boltiv-pin-overlay.show .boltiv-pin-card{transform:translateY(0) scale(1)}
  .boltiv-pin-lock{width:58px;height:58px;margin:0 auto 14px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#fffdf4;border:1px solid #b8860b;color:#b8860b;font-size:26px;font-weight:1000}
  .boltiv-pin-status{color:#b8860b;font-size:10px;font-weight:1000;letter-spacing:1px;margin-bottom:7px}
  .boltiv-pin-title{color:#171717;font-size:20px;font-weight:1000}
  .boltiv-pin-message{color:#777;font-size:11px;line-height:1.55;margin:8px 0 18px}
  .boltiv-pin-boxes{display:flex;justify-content:center;gap:10px;margin:0 0 18px}
  .boltiv-pin-input{width:52px;height:58px;box-sizing:border-box;border:1px solid #dcdcd6;border-radius:13px;background:#fff;color:#171717;text-align:center;font-size:22px;font-weight:1000;outline:none}
  .boltiv-pin-input:focus{border-color:#b8860b;box-shadow:0 0 0 2px rgba(184,134,11,.10)}
  .boltiv-pin-error{min-height:17px;color:#b94c4c;font-size:10px;font-weight:800;margin:-7px 0 8px}
  .boltiv-pin-confirm{width:100%;padding:14px;border:0;border-radius:13px;background:#b8860b;color:#fff;font-family:inherit;font-size:11px;font-weight:1000;letter-spacing:.6px}
  .boltiv-pin-cancel{width:100%;margin-top:9px;padding:12px;border:1px solid #e5e5e1;border-radius:13px;background:#fff;color:#666;font-family:inherit;font-size:10px;font-weight:900}
  .boltiv-pin-confirm:disabled{opacity:.55}
  `;
  document.head.appendChild(style);
  const overlay=document.createElement('div');
  overlay.className='boltiv-pin-overlay';
  overlay.innerHTML=`<div class="boltiv-pin-card" role="dialog" aria-modal="true">
    <div class="boltiv-pin-lock">🔒</div>
    <div class="boltiv-pin-status">SECURE PURCHASE</div>
    <div class="boltiv-pin-title">Enter Transaction PIN</div>
    <div class="boltiv-pin-message">Enter your 4-digit transaction PIN to authorize this purchase. Your PIN is not stored on this page.</div>
    <div class="boltiv-pin-boxes"></div>
    <div class="boltiv-pin-error" aria-live="polite"></div>
    <button type="button" class="boltiv-pin-confirm">CONFIRM PURCHASE</button>
    <button type="button" class="boltiv-pin-cancel">CANCEL</button>
  </div>`;
  document.body.appendChild(overlay);
  const boxes=overlay.querySelector('.boltiv-pin-boxes'),inputs=[];
  for(let i=0;i<4;i++){
    const input=document.createElement('input');
    input.className='boltiv-pin-input';input.type='password';input.inputMode='numeric';input.maxLength=1;
    boxes.appendChild(input);inputs.push(input);
    input.addEventListener('input',()=>{input.value=input.value.replace(/\D/g,'').slice(0,1);if(input.value&&i<3)inputs[i+1].focus()});
    input.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!input.value&&i>0)inputs[i-1].focus();if(e.key==='Enter')overlay.querySelector('.boltiv-pin-confirm').click()});
  }
  let resolver=null;
  const error=overlay.querySelector('.boltiv-pin-error'),confirm=overlay.querySelector('.boltiv-pin-confirm');
  function close(value){overlay.classList.remove('show');document.body.style.overflow='';const r=resolver;resolver=null;inputs.forEach(x=>x.value='');error.textContent='';confirm.disabled=false;if(r)r(value)}
  confirm.onclick=()=>{const pin=inputs.map(x=>x.value).join('');if(!/^\d{4}$/.test(pin)){error.textContent='Enter all 4 PIN digits.';return}confirm.disabled=true;close(pin)};
  overlay.querySelector('.boltiv-pin-cancel').onclick=()=>close(null);
  overlay.addEventListener('click',e=>{if(e.target===overlay)close(null)});
  window.BoltivTransactionPin={request:()=>{if(resolver)return Promise.resolve(null);overlay.classList.add('show');document.body.style.overflow='hidden';setTimeout(()=>inputs[0].focus(),80);return new Promise(resolve=>resolver=resolve)}};
})();
