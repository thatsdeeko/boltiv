const http=require("node:http");
const crypto=require("node:crypto");
const {Pool}=require("pg");

const PORT=process.env.PORT||3000;
const DATABASE_URL=process.env.DATABASE_URL||"";
const BACKEND_PUBLIC_URL=(process.env.BACKEND_PUBLIC_URL||process.env.RENDER_EXTERNAL_URL||"").replace(/\/+$/,"");

const FLW_SECRET_KEY=process.env.FLW_SECRET_KEY||"";
const FLW_BASE_URL=(process.env.FLW_BASE_URL||"https://api.flutterwave.com/v3").replace(/\/+$/,"");
const FLW_SECRET_HASH=process.env.FLW_SECRET_HASH||"";
const FLW_CALLBACK_URL=process.env.FLW_CALLBACK_URL||"";
const FRONTEND_URL=process.env.FRONTEND_URL||"https://boltiv.ng";

const ADMIN_EMAIL=process.env.ADMIN_EMAIL||"";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";

const VTUGATE_API_BASE_URL=(process.env.VTUGATE_API_BASE_URL||"https://api.vtugate.com").replace(/\/+$/,"");
const VTUGATE_API_KEY=process.env.VTUGATE_API_KEY||"";
const VTUGATE_SERVICE_MAP=JSON.parse(process.env.VTUGATE_SERVICE_MAP||'{}');

const RESEND_API_KEY=process.env.RESEND_API_KEY||"";
// Use a Resend-safe sender for testing when MAIL_FROM is not configured.
// For production, set MAIL_FROM to an address on a domain verified in Resend.
const MAIL_FROM=(process.env.MAIL_FROM||"BOLTIV <onboarding@resend.dev>").trim();
const FRONTEND_ORIGINS=String(process.env.FRONTEND_ORIGIN||(()=>{try{return new URL(FRONTEND_URL).origin}catch{return FRONTEND_URL}})())
.split(",")
.map(v=>v.trim())
.filter(Boolean);
const DEFAULT_FRONTEND_ORIGIN=FRONTEND_ORIGINS[0]||"";
function corsOrigin(req){
const origin=String(req.headers.origin||"");
if(origin&&FRONTEND_ORIGINS.includes(origin))return origin;
return DEFAULT_FRONTEND_ORIGIN;
}

const pool=new Pool({
connectionString:DATABASE_URL,
ssl:DATABASE_URL?{rejectUnauthorized:false}:false
});

// Lightweight in-process abuse protection. For multi-instance deployments,
// replace this with a shared store such as Redis.
const rateBuckets=new Map();
function requestIp(req){
return String(req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"unknown").split(",")[0].trim();
}
function rateLimit(req,key,limit,windowMs){
const now=Date.now();
const bucketKey=`${key}:${requestIp(req)}`;
let b=rateBuckets.get(bucketKey);
if(!b||b.resetAt<=now)b={count:0,resetAt:now+windowMs};
b.count++;
rateBuckets.set(bucketKey,b);
if(b.count>limit)return {allowed:false,retryAfter:Math.ceil((b.resetAt-now)/1000)};
return {allowed:true};
}
function rateLimitedResponse(res,rl){
res.setHeader("Retry-After",String(rl.retryAfter));
return send(res,429,{success:false,message:"Too many requests. Please try again later."});
}
setInterval(()=>{const now=Date.now();for(const [k,v] of rateBuckets){if(v.resetAt<=now)rateBuckets.delete(k);}},10*60*1000).unref();

function send(res,status,data){
if(FRONTEND_URL.startsWith("https://"))res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
res.writeHead(status,{
"Content-Type":"application/json",
"Access-Control-Allow-Origin":res.__corsOrigin||DEFAULT_FRONTEND_ORIGIN,
"Vary":"Origin",
"Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS",
"Access-Control-Allow-Headers":"Content-Type,Authorization,X-Idempotency-Key,X-Admin-CSRF",
"Access-Control-Allow-Credentials":"true",
"X-Content-Type-Options":"nosniff",
"X-Frame-Options":"DENY",
"Referrer-Policy":"strict-origin-when-cross-origin",
"Cache-Control":"no-store"
});
res.end(JSON.stringify(data));
return true;
}

async function body(req){
return new Promise((resolve,reject)=>{
let data="";

req.on("data",chunk=>{
data+=chunk;
if(data.length>1024*1024){req.destroy();reject(new Error("Request body too large."));}
});

req.on("end",()=>{
try{
resolve(data?JSON.parse(data):{});
}catch(error){
reject(error);
}
});

req.on("error",reject);
});
}

async function db(query,params=[]){
return pool.query(query,params);
}

function clean(value){
return String(value??"").trim();
}

// VTUGATE has used slightly different casing/nesting for catalogue fields.
// Read catalogue values case-insensitively so fields such as Validity/validity
// are never lost when the provider changes response casing.
function findCatalogField(value, names, depth=0){
  if(value==null || depth>4) return undefined;
  const wanted=new Set(names.map(x=>String(x).replace(/[^a-z0-9]/gi,"").toLowerCase()));
  if(Array.isArray(value)){
    for(const item of value){ const found=findCatalogField(item,names,depth+1); if(found!==undefined) return found; }
    return undefined;
  }
  if(typeof value!=="object") return undefined;
  for(const [key,val] of Object.entries(value)){
    const normalized=String(key).replace(/[^a-z0-9]/gi,"").toLowerCase();
    if(wanted.has(normalized) && val!==undefined && val!==null && String(val).trim()!=="") return val;
  }
  for(const val of Object.values(value)){
    if(val && typeof val==="object"){ const found=findCatalogField(val,names,depth+1); if(found!==undefined) return found; }
  }
  return undefined;
}

function normalizeCatalogValidity(plan){
  const value=findCatalogField(plan,[
    "validity","validity_period","validityPeriod","validityDuration",
    "duration","duration_text","expiry","expiry_period","expiryPeriod",
    "validity_days","validityDays","days","validity_in_days"
  ]);
  if(value!==undefined && value!==null && String(value).trim()!=="") return clean(value);
  return "";
}

function validEmail(email){
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPhone(phone){
return /^0\d{10}$/.test(phone);
}

function validAmount(amount){
return Number.isFinite(amount)&&amount>0;
}


/* =========================================================
   VTUGATE DATA CATALOG + SERVICE PRICING
   ========================================================= */

async function getService(key){
const serviceKey=clean(key).toLowerCase();
if(!serviceKey)return null;
const result=await db(`SELECT key,name,icon,enabled,fee,maintenance,config,updated_at FROM services WHERE key=$1 LIMIT 1`,[serviceKey]);
if(!result.rows.length)return null;
const row=result.rows[0];
return {...row,fee:Number(row.fee||0),config:row.config&&typeof row.config==="object"?row.config:{}};
}

function pricingConfig(service){
const config=service?.config&&typeof service.config==="object"?service.config:{};
const adminPricing=config.pricing&&typeof config.pricing==="object"?config.pricing:null;
if(adminPricing){
  let mode=clean(adminPricing.mode||"discount").toLowerCase();
  if(mode==="discount"||mode==="provider_discount")mode="provider_discount";
  else if(mode==="fixed"||mode==="fixed_profit")mode="fixed_profit";
  else mode="provider_discount";
  const discountPct=Number(adminPricing.discount_pct??adminPricing.discountPercent??0);
  const fixedProfit=Number(adminPricing.fixed_profit??adminPricing.fixedProfit??0);
  const serviceFee=Number(service?.fee||0);
  return {markup_mode:mode,markup_pct:Number.isFinite(discountPct)?Math.min(100,Math.max(0,discountPct)):0,markup_fixed:Number.isFinite(fixedProfit)?Math.max(0,fixedProfit):0,service_fee:Number.isFinite(serviceFee)?Math.max(0,serviceFee):0};
}
let mode=clean(config.markup_mode??config.markupMode??config.pricing_mode??config.pricingMode??"none").toLowerCase();
if(mode==="percent")mode="percentage"; if(mode==="fixed_amount")mode="fixed"; if(mode==="cost_plus")mode="percentage_plus_fixed";
const pct=Number(config.markup_pct??config.markupPercent??config.percentage??0);
const fixed=Number(config.markup_fixed??config.markupFixed??config.fixed??service?.fee??0);
return {markup_mode:["none","percentage","fixed","percentage_plus_fixed"].includes(mode)?mode:"none",markup_pct:Number.isFinite(pct)?Math.max(0,pct):0,markup_fixed:Number.isFinite(fixed)?Math.max(0,fixed):0,service_fee:0};
}

function customerPriceFromCost(cost,pricing){
const n=Number(cost); if(!Number.isFinite(n)||n<=0)return null; const p=pricing||{}; let price=n;
if(p.markup_mode==="provider_discount"){price=n*(1-Number(p.markup_pct||0)/100)+Number(p.markup_fixed||0)+Number(p.service_fee||0);}
else if(p.markup_mode==="fixed_profit"){price=n+Number(p.markup_fixed||0)+Number(p.service_fee||0);}
else if(p.markup_mode==="fixed")price+=Number(p.markup_fixed||0);
else if(p.markup_mode==="percentage")price+=n*Number(p.markup_pct||0)/100;
else if(p.markup_mode==="percentage_plus_fixed")price+=n*Number(p.markup_pct||0)/100+Number(p.markup_fixed||0);
return Number(price.toFixed(2));
}

function normalizeDataNetwork(value){const n=clean(value).toUpperCase().replace(/\s+/g,""); if(n==="9MOBILE"||n==="ETISALAT")return "9MOBILE"; return ["MTN","AIRTEL","GLO"].includes(n)?n:"";}
// Nigerian MSISDN prefix → network map, mirrored from the airtime.html client-side
// detector. Number portability (MNP, active since 2013) means a prefix no longer
// guarantees the *current* network, so this is used to flag a likely mismatch and
// require the client to send networkConfirmed:true — never a hard block on its own.
const NETWORK_PREFIXES={"0803":"MTN","0806":"MTN","0703":"MTN","0706":"MTN","0704":"MTN","0813":"MTN","0814":"MTN","0816":"MTN","0810":"MTN","0913":"MTN","0916":"MTN","0903":"MTN","0906":"MTN","0802":"AIRTEL","0808":"AIRTEL","0708":"AIRTEL","0701":"AIRTEL","0812":"AIRTEL","0902":"AIRTEL","0901":"AIRTEL","0904":"AIRTEL","0907":"AIRTEL","0911":"AIRTEL","0912":"AIRTEL","0805":"GLO","0807":"GLO","0705":"GLO","0815":"GLO","0811":"GLO","0905":"GLO","0915":"GLO","0809":"9MOBILE","0817":"9MOBILE","0818":"9MOBILE","0908":"9MOBILE","0909":"9MOBILE"};
function detectNetworkFromPhone(phone){return NETWORK_PREFIXES[clean(phone).slice(0,4)]||"";}
function findTransactionField(value,keys,depth=0){if(depth>6||value==null)return "";if(Array.isArray(value)){for(const item of value){const found=findTransactionField(item,keys,depth+1);if(found)return found;}return "";}if(typeof value!=="object")return "";for(const key of keys){const v=value[key];if(v!==undefined&&v!==null&&String(v).trim()!=="")return String(v).trim();}for(const key of Object.keys(value)){const found=findTransactionField(value[key],keys,depth+1);if(found)return found;}return "";}

function vtugateStatus(data,responseOk=true){
const raw=data?.data?.provider_status!==undefined?data.data.provider_status:(data?.status??data?.data?.status??data?.state??data?.result);
const value=typeof raw==="boolean"?(raw?"successful":"failed"):String(raw??"").trim().toLowerCase();
if(["pending","processing","initiated","queued","in progress"].includes(value))return "pending";
if(["failed","failure","error","declined","rejected","false"].includes(value))return "failed";
if(["refunded","refund"].includes(value))return "refunded";
if(["success","successful","completed","complete","delivered","true"].includes(value))return "successful";
if(data?.status===true||data?.data?.provider_status===true)return "successful";
if(data?.status===false||data?.data?.provider_status===false)return "failed";
return responseOk?"successful":"failed";
}

async function vtugateRequest(endpoint,payload={},options={}){
if(!VTUGATE_API_KEY)return {success:false,outcome:"unavailable",statusCode:503,message:"VTUGATE API is not configured on the server."};
const timeoutMs=Number(options.timeoutMs||20000); const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
try{
const form=new URLSearchParams(); for(const [key,value] of Object.entries(payload||{})){if(value!==undefined&&value!==null)form.set(key,String(value));}
const response=await fetch(`${VTUGATE_API_BASE_URL}/${endpoint.replace(/^\/+/,"")}`,{method:"POST",headers:{Authorization:`Bearer ${VTUGATE_API_KEY}`,"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},body:form.toString(),signal:controller.signal});
let data={};try{data=await response.json();}catch{}
const outcome=vtugateStatus(data,response.ok);
const providerReference=findTransactionField(data,["transaction_id","external_reference","reference","transactionId","id","request_id","requestId"])||null;
const message=data?.message||data?.data?.provider_message||data?.data?.description||data?.error||data?.detail||"";
if(response.ok&&outcome==="successful")return{success:true,outcome,statusCode:response.status,data,providerReference,message:message||"Transaction successful."};
if(outcome==="pending")return{success:true,outcome,statusCode:response.status,data,providerReference,message:message||"Transaction is being processed."};
if(outcome==="refunded")return{success:false,outcome,statusCode:response.status,data,providerReference,message:message||"Transaction was refunded by the provider."};
if(response.status>=500||response.status===408||response.status===409)return{success:false,outcome:"unknown",statusCode:response.status,data,providerReference,message:message||"VTUGATE could not confirm the transaction. Status verification is required."};
return{success:false,outcome:"failed",statusCode:response.status,data,providerReference,message:message||`VTUGATE request failed (${response.status}).`};
}catch(e){return{success:false,outcome:"unknown",statusCode:e.name==="AbortError"?504:502,data:{},providerReference:null,message:e.name==="AbortError"?"VTUGATE did not respond in time. Your transaction is being verified.":"VTUGATE connection could not be confirmed. Your transaction is being verified."};}
finally{clearTimeout(timer);}}

async function fetchVTUGATEServices(all=true){return vtugateRequest(all?"api/v1/fetchallservices":"api/v1/fetchservices",{});}
async function getVTUGATEAccountDetails(){return vtugateRequest("api/v1/accountdetails",{});}
const vtugateServiceCache={at:0,data:[]};
// Cable TV plans aren't exposed through a live VTUGATE pricing endpoint the way data
// and education PINs are, so — unlike those services — cable had no server-side price
// source to check against: the client-supplied amount was trusted as-is. That let a
// tampered request pay any amount for a real plan, and it meant provider price changes
// never reached customers. This table is the authoritative source cable purchases are
// now validated against, mirroring the plans shown on the cable page.
const CABLE_PLANS={
DSTV:{Compact:19000,Confam:11000,Yanga:6000},
GOTV:{Jolli:5800,Max:8500}
};
function getCablePlanPrice(provider,plan){
const providerPlans=CABLE_PLANS[clean(provider).toUpperCase()];
if(!providerPlans)return null;
const price=providerPlans[clean(plan)];
return Number.isFinite(price)&&price>0?price:null;
}
async function getVTUGATEServiceId(category,provider=""){
const keys=[provider,String(provider).toUpperCase(),String(provider).toLowerCase(),category,String(category).toUpperCase(),String(category).toLowerCase()];
for(const key of keys){const explicit=VTUGATE_SERVICE_MAP?.[key];if(Number(explicit)>0)return Number(explicit);}
const envKeys={data:["VTUGATE_DATA_SERVICE_ID"],airtime:["VTUGATE_AIRTIME_SERVICE_ID"],cable:["VTUGATE_CABLE_SERVICE_ID"],electricity:["VTUGATE_ELECTRICITY_SERVICE_ID"],education:["VTUGATE_EDUCATION_SERVICE_ID"]};
for(const key of (envKeys[category]||[])){if(Number(process.env[key])>0)return Number(process.env[key]);}
if(Date.now()-vtugateServiceCache.at>300000){const r=await fetchVTUGATEServices(true);if(!r.success)throw new Error(r.message||"Unable to load VTUGATE services.");
 const root=r.data?.data??r.data;
 const records=[];
 const visit=(value,depth=0)=>{if(!value||depth>8)return;if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}if(typeof value!=="object")return;
   const id=Number(value.service_id??value.serviceId??value.serviceID??value.id??value.service?.id??value.service?.service_id??value.service?.serviceId??0);
   const hay=[value.name,value.service_name,value.serviceName,value.service_title,value.title,value.label,value.code,value.service_code,value.serviceCode,value.slug,value.type,value.category,value.service_type,value.serviceType,value.provider,value.network,value.description,value.service?.name,value.service?.service_name,value.service?.code].filter(v=>v!==undefined&&v!==null).join(" ").toLowerCase();
   if(id>0&&hay)records.push({id,hay,raw:value});
   for(const [k,v] of Object.entries(value)){if(["raw","meta","pagination"].includes(k))continue;visit(v,depth+1);}
 };
 visit(root);
 vtugateServiceCache.data=records;vtugateServiceCache.at=Date.now();}
const aliases={airtime:["airtime","mobile airtime"],data:["data","mobile data","internet data","data bundle","data bundles","data plan","data plans","mobile data bundle"],cable:["cable","cable tv","cable television","dstv","gotv","startimes","showmax"],electricity:["electricity","electric","power","power bill","electricity bill"],education:["education","education pin","education pins","exam pin","exam pins"]};
// Known providers per category, used only as a cross-check below — never as the primary
// match — to catch a catalog entry that matches the requested provider but ALSO looks like
// it belongs to a different one (e.g. a bundled/mislabeled listing), which the alias table
// above has no way to anticipate.
const KNOWN_PROVIDERS={airtime:["mtn","airtel","glo","9mobile"],cable:["dstv","gotv","startimes","showmax"]};
const p=clean(provider).toLowerCase();
function termMatches(hay,term){return !!term&&(hay===term||hay.includes(` ${term} `)||hay.startsWith(`${term} `)||hay.endsWith(` ${term}`));}
const categoryTerms=aliases[category]||[category];
const matchesCategory=x=>categoryTerms.some(w=>termMatches(x.hay,w));
// Previously this OR'd category aliases together with the provider name into one list and
// returned the first record matching ANY of them — so a generic/other-network "airtime"
// record could satisfy the match on the category term alone, before the provider was ever
// checked, and BOLTIV would send VTUGATE the wrong network's service_id even though the
// correct network name was in the payload (VTUGATE routes by service_id, not by that field).
// A candidate must now match the category AND (when a provider is given) the provider.
const providerHit=p?vtugateServiceCache.data.find(x=>matchesCategory(x)&&termMatches(x.hay,p)):null;
if(p){
  // Second line of defense: don't silently fall back to "any record in this category" when
  // a specific provider was requested — that's the same failure mode as the bug above, just
  // approached from a different angle. Fail loudly instead of guessing a network.
  if(!providerHit)throw new Error(`VTUGATE service ID for ${provider} ${category} could not be confirmed \u2014 refusing to guess a network. Check the VTUGATE service catalog and consider setting VTUGATE_SERVICE_MAP explicitly.`);
  // Even a record that matched our provider term could be an ambiguous/mislabeled catalog
  // entry that also mentions a different known provider in this category. Refuse to trust it.
  const otherProviders=(KNOWN_PROVIDERS[category]||[]).filter(other=>other!==p);
  const ambiguous=otherProviders.some(other=>termMatches(providerHit.hay,other));
  if(ambiguous)throw new Error(`VTUGATE service catalog entry resolved for ${provider} ${category} looks ambiguous (it also matches another provider name). Refusing to guess \u2014 check the VTUGATE service catalog and consider setting VTUGATE_SERVICE_MAP explicitly.`);
  return providerHit.id;
}
const categoryHit=vtugateServiceCache.data.find(matchesCategory);
if(!categoryHit)throw new Error(`VTUGATE service ID for ${category} is not configured.`);
return categoryHit.id;
}

function parseCatalogNumber(value){
  if(value===undefined||value===null)return NaN;
  if(typeof value==='number')return Number(value);
  const text=String(value).replace(/[₦,\s]/g,'').trim();
  if(!text)return NaN;
  const n=Number(text);
  return Number.isFinite(n)?n:NaN;
}

function parseDataSizeMb(plan,name=''){
  // Prefer an explicit unit in the provider value, then the plan name.
  const candidates=[
    ['size_mb',plan?.size_mb],['sizeMb',plan?.sizeMb],['data_mb',plan?.data_mb],['dataMb',plan?.dataMb],
    ['volume',plan?.volume],['size',plan?.size],['quantity',plan?.quantity],['data_size',plan?.data_size],['dataSize',plan?.dataSize]
  ];
  const nameText=String(name||'');
  const nameMatch=nameText.match(/(\d+(?:\.\d+)?)\s*(GB|MB)\b/i);
  for(const [key,value] of candidates){
    if(value===undefined||value===null||value==='')continue;
    const text=String(value).trim();
    const unitMatch=text.match(/(\d+(?:\.\d+)?)\s*(GB|MB)\b/i);
    if(unitMatch){
      const amount=Number(unitMatch[1]);
      if(Number.isFinite(amount)&&amount>0)return Math.round(unitMatch[2].toUpperCase()==='GB'?amount*1024:amount);
    }
    const numeric=parseCatalogNumber(value);
    if(!Number.isFinite(numeric)||numeric<=0)continue;
    // Explicit MB fields are always MB. For generic fields, use the plan
    // name's unit when available (e.g. API returns 0.5 with name "500MB").
    if(/^size_mb$|^sizeMb$|^data_mb$|^dataMb$/.test(key))return Math.round(numeric);
    if(nameMatch){
      const nameAmount=Number(nameMatch[1]);
      const nameUnit=nameMatch[2].toUpperCase();
      if(Number.isFinite(nameAmount)&&nameAmount>0){
        // Generic provider fields (volume/size/quantity) are sometimes
        // returned in GB while the plan name is the authoritative display
        // size. Prefer the explicit unit in the plan name instead of
        // accidentally treating 0.5 as 0.5MB for a "500MB" plan.
        if(nameUnit==='MB')return Math.round(nameAmount);
        // For GB names, a small generic numeric value is normally GB
        // (e.g. 0.5, 1, 1.5). Larger values are commonly already MB.
        if(numeric<=100)return Math.round(numeric*1024);
        return Math.round(nameAmount*1024);
      }
    }
    return Math.round(numeric);
  }
  if(nameMatch){
    const amount=Number(nameMatch[1]);
    if(Number.isFinite(amount)&&amount>0)return Math.round(nameMatch[2].toUpperCase()==='GB'?amount*1024:amount);
  }
  return 0;
}

function collectVTUGATEPlanCandidates(value,inheritedNetwork='',out=[],seen=new Set(),depth=0,inheritedPlanId=''){
  if(value==null||depth>12)return out;
  if(Array.isArray(value)){for(const item of value)collectVTUGATEPlanCandidates(item,inheritedNetwork,out,seen,depth+1,inheritedPlanId);return out;}
  if(typeof value!=='object')return out;

  const ownNetwork=normalizeDataNetwork(findCatalogField(value,[
    'network','network_name','networkName','network_code','networkCode','operator','operator_name','operatorName','provider','provider_name','providerName','carrier'
  ])||inheritedNetwork)||inheritedNetwork;

  const idValue=findCatalogField(value,[
    'plan_id','planId','planID','bundle_id','bundleId','bundleID','id','product_id','productId','productID','code','product_code','productCode','bundle_code','bundleCode','plan_code','planCode','service_id','serviceId'
  ]) ?? inheritedPlanId;
  const nameValue=findCatalogField(value,[
    'plan_name','planName','name','plan','data_plan','dataPlan','bundle_name','bundleName','bundle','product_name','productName','description','title','label'
  ]);
  const priceValue=findCatalogField(value,[
    'vendor_price','vendorPrice','agent_price','agentPrice','user_price','userPrice','merchant_price','merchantPrice','retail_price','retailPrice','selling_price','sellingPrice','sell_price','sellPrice','price','amount','cost','plan_price','planPrice','amount_to_charge','amountToCharge'
  ]);
  const id=parseCatalogNumber(idValue);
  const price=parseCatalogNumber(priceValue);
  const name=clean(nameValue);
  const hasPlanSignals=(id>0||clean(idValue)!=='')&&(price>0||clean(priceValue)!=='')&&name!=='';
  if(hasPlanSignals){
    const candidate={...value,__network:ownNetwork,__plan_id_fallback:clean(idValue)};
    const key=JSON.stringify([clean(idValue),name,price,ownNetwork]);
    if(!seen.has(key)){seen.add(key);out.push(candidate);}
  }

  for(const [key,child] of Object.entries(value)){
    if(['raw','meta','pagination','links'].includes(key))continue;
    let childNetwork=ownNetwork;
    const keyNetwork=normalizeDataNetwork(key);
    if(keyNetwork)childNetwork=keyNetwork;
    let childPlanId=inheritedPlanId;
    if(/^(?:\d+)(?:\.0+)?$/.test(String(key).trim())) childPlanId=String(key).trim().replace(/\.0+$/,'');
    collectVTUGATEPlanCandidates(child,childNetwork,out,seen,depth+1,childPlanId);
  }
  return out;
}

function extractVTUGATEPlanCandidates(responseData,selected){
  const roots=[responseData?.data,responseData?.plans,responseData?.data?.plans,responseData?.data?.data,responseData];
  const out=[];
  const seen=new Set();
  for(const root of roots){if(root)collectVTUGATEPlanCandidates(root,selected,out,seen);}
  return out;
}

async function getVTUGATEDataServiceIds(network){
const selected=normalizeDataNetwork(network);
if(!selected)throw new Error('Unsupported network.');
const ids=[];
const add=v=>{const n=Number(v);if(Number.isInteger(n)&&n>0&&!ids.includes(n))ids.push(n);};
// Explicit configuration first.
for(const key of [selected,selected.toUpperCase(),selected.toLowerCase(),'data','DATA'])add(VTUGATE_SERVICE_MAP?.[key]);
add(process.env.VTUGATE_DATA_SERVICE_ID);
// Build a complete Data-service candidate list from VTUGATE.
if(Date.now()-vtugateServiceCache.at>300000){
  const r=await fetchVTUGATEServices(true);
  if(r.success){
    const root=r.data?.data??r.data;
    const records=[];
    const visit=(value,depth=0)=>{
      if(!value||depth>8)return;
      if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}
      if(typeof value!=='object')return;
      const id=Number(value.service_id??value.serviceId??value.serviceID??value.id??value.service?.id??value.service?.service_id??value.service?.serviceId??0);
      const hay=[value.name,value.service_name,value.serviceName,value.service_title,value.title,value.label,value.code,value.service_code,value.serviceCode,value.slug,value.type,value.category,value.service_type,value.serviceType,value.provider,value.network,value.network_name,value.networkName,value.data_type,value.dataType,value.description,value.service?.name,value.service?.service_name,value.service?.code].filter(v=>v!==undefined&&v!==null).join(' ').toLowerCase();
      const serviceType=String(value.service_type||value.serviceType||'').toLowerCase();
      const networkName=String(value.network_name||value.networkName||value.network||'').toLowerCase();
      if(id>0&&hay)records.push({id,hay,serviceType,networkName,raw:value});
      for(const [k,v] of Object.entries(value)){if(['raw','meta','pagination'].includes(k))continue;visit(v,depth+1);}
    };
    visit(root);
    vtugateServiceCache.data=records;
    vtugateServiceCache.at=Date.now();
  }
}
// Primary, precise match: VTUGATE tags each service with an explicit service_type
// and network_name — use those directly rather than scanning free text, which can
// accidentally pull in other networks' services or unrelated business/broadband products.
const structuredMatches=vtugateServiceCache.data.filter(x=>x.serviceType==='data'&&x.networkName===selected.toLowerCase());
if(structuredMatches.length){
  for(const x of structuredMatches)add(x.id);
}else{
  // Fallback for older/differently-shaped VTUGATE responses that lack service_type/network_name.
  const aliases=['data','mobile data','internet data','data bundle','data bundles','data plan','data plans','mobile data bundle'];
  const has=(hay,w)=>{const t=String(w).toLowerCase();return hay===t||hay.includes(` ${t} `)||hay.startsWith(`${t} `)||hay.endsWith(` ${t}`)||hay.includes(t);};
  const matches=vtugateServiceCache.data.filter(x=>aliases.some(w=>has(x.hay,w)));
  const networkMatches=matches.filter(x=>has(x.hay,selected.toLowerCase()));
  for(const x of networkMatches)add(x.id);
}
if(!ids.length)throw new Error(`VTUGATE service ID for ${selected} data is not configured.`);
return ids;
}

async function fetchVTUGATEDataPlans(network){
const selected=normalizeDataNetwork(network);
if(!selected)throw new Error('Unsupported network.');
const serviceIds=await getVTUGATEDataServiceIds(selected);
const responses=await Promise.all(serviceIds.map(async serviceId=>{
  let response=await vtugateRequest('api/v1/fetchdataplans',{service_id:serviceId});
  if(!response.success){
    const retry=await vtugateRequest('api/v1/fetchdataplans',{service_id:serviceId,network:selected});
    if(retry.success)response=retry;
  }
  return {serviceId,response};
}));
let bestRaw=[];
let lastMessage='Unable to load VTUGATE data plans.';
for(const {serviceId,response} of responses){
  if(!response.success){lastMessage=response.message||lastMessage;continue;}
  // Tag each candidate with the service_id we actually requested it under —
  // VTUGATE's plan objects don't always echo their own service_id back, and
  // without this fallback those plans resolve to service_id 0, which makes
  // every purchase attempt fail authoritative lookup at buy time.
  const raw=extractVTUGATEPlanCandidates(response.data,selected).map(p=>({...p,__requested_service_id:serviceId}));
  if(raw.length)bestRaw=bestRaw.concat(raw);
}
if(!bestRaw.length)throw new Error(lastMessage);
const raw=bestRaw;
const normalized=raw.map(p=>{
  const channelRaw=findCatalogField(p,['plan_type','planType','data_type','dataType','bundle_type','bundleType','service_type','serviceType','category','plan_category','planCategory','channel','channel_name','channelName','type','product_type','productType']);
  const channel=clean(channelRaw??'');
  const name=clean(findCatalogField(p,['plan_name','planName','name','plan','bundle_name','bundleName','product_name','productName','description','title','label'])??'');
  const channelSearch=[channel,clean(p.plan_name||''),clean(p.name||''),clean(p.description||''),clean(p.title||''),clean(p.label||'')].join(' ').toLowerCase();
  const salesChannel=/\b(sme|gifting)\b/i.test(channelSearch)?( /\bsme\b/i.test(channelSearch)?'SME':'Gifting'):'';
  const networkName=normalizeDataNetwork(findCatalogField(p,['network','network_name','networkName','network_code','networkCode','operator','operator_name','provider','provider_name'])??p.__network??selected)||selected;
  const codeRaw=findCatalogField(p,['code','plan_code','planCode','bundle_code','bundleCode','product_code','productCode']);
  const idRaw=findCatalogField(p,['id','plan_id','planId','bundle_id','bundleId','product_id','productId']);
  const id=parseCatalogNumber(codeRaw??idRaw);
  const planCode=clean(codeRaw??idRaw??'');
  const price=parseCatalogNumber(findCatalogField(p,['vendor_price','vendorPrice','agent_price','agentPrice','user_price','userPrice','selling_price','sellingPrice','price','amount','cost','plan_price','planPrice']));
  const rawValidity=normalizeCatalogValidity(p);
  const sizeMb=parseDataSizeMb(p,name);
  const validityMatch=String(rawValidity).match(/(\d+(?:\.\d+)?)\s*(day|days|hour|hours|minute|minutes)\b/i);
  const explicitDays=parseCatalogNumber(findCatalogField(p,['validity_days','validityDays','days','validity_in_days']));
  const validityDays=Number.isFinite(explicitDays)&&explicitDays>0?explicitDays:(validityMatch&&/day/i.test(validityMatch[2])?Number(validityMatch[1]):0);
  const parsedServiceId=parseCatalogNumber(findCatalogField(p,['service_id','serviceId','serviceID']));
  const serviceId=Number.isFinite(parsedServiceId)&&parsedServiceId>0?parsedServiceId:Number(p.__requested_service_id||0);
  const deliveryRateRaw=parseCatalogNumber(findCatalogField(p,['delivery_rate','deliveryRate']));
  const deliveryRate=Number.isFinite(deliveryRateRaw)?deliveryRateRaw:null;
  return{...p,network_name:networkName,name,sales_channel:salesChannel,plan_id:id,plan_code:planCode||String(id||''),price,size_mb:sizeMb,validity_days:validityDays,validity:rawValidity,validity_period:rawValidity,duration:rawValidity,service_id:Number.isFinite(serviceId)&&serviceId>0?serviceId:0,delivery_rate:deliveryRate};
});
const labeledNetworks=new Set(normalized.map(p=>p.network_name).filter(Boolean));
const hasOtherNetwork=Array.from(labeledNetworks).some(n=>n!==selected);
const nonRetailTerms=['thryve','msme','fibrenet','hynetflex','mifi','router','learning bundle'];
const isNonRetail=name=>{const lower=String(name||'').toLowerCase();return nonRetailTerms.some(term=>lower.includes(term));};
const cleaned=normalized.filter(p=>p.plan_code&&p.price>0&&p.name&&['SME','Gifting'].includes(p.sales_channel)&&Number(p.size_mb||0)>=500&&!isNonRetail(p.name)&&(!hasOtherNetwork||p.network_name===selected));
// Multiple sales channels (SME, Gifting, Awoof, Transfer, Direct, Data Share) often sell the exact same
// bundle size+validity at different prices and reliability. Keep only the best one per (size, validity):
// prefer the most reliable delivery track record, and use price as the tiebreaker.
const bestByBundle=new Map();
for(const p of cleaned){
  const bundleKey=p.size_mb>0&&p.validity_days>0?`${p.size_mb}:${p.validity_days}`:`unkeyed:${p.plan_code}`;
  const existing=bestByBundle.get(bundleKey);
  if(!existing){bestByBundle.set(bundleKey,p);continue;}
  const pRate=p.delivery_rate??50, exRate=existing.delivery_rate??50;
  if(pRate>exRate||(pRate===exRate&&p.price<existing.price))bestByBundle.set(bundleKey,p);
}
return Array.from(bestByBundle.values());
}
const vtugatePlanCache=new Map();
function planLookupKey(planCode,serviceId){return `${Number(serviceId)||0}:${clean(planCode)}`;}
async function getAuthoritativeVTUGATEDataPlan(network,planKey){const selected=normalizeDataNetwork(network);const key=clean(planKey);if(!selected||!key)throw new Error("Invalid data plan.");let entry=vtugatePlanCache.get(selected);if(!entry||Date.now()-entry.at>60000){entry={at:Date.now(),plans:await fetchVTUGATEDataPlans(selected)};vtugatePlanCache.set(selected,entry);}const plan=entry.plans.find(x=>planLookupKey(x.plan_code||x.code||"",x.service_id)===key||String(x.plan_code||x.code||"")===key);if(!plan)throw new Error("The selected data plan is no longer available.");const service=await getService("data");if(!service||service.enabled===false||service.maintenance===true)throw new Error("Data service is currently unavailable.");let providerServiceId=Number(plan.service_id||0);if(!(providerServiceId>0))throw new Error("VTUGATE did not return a service_id for the selected data plan.");const customerPrice=customerPriceFromCost(plan.price,pricingConfig(service));return{...plan,plan_code:clean(plan.plan_code||plan.code||""),service_id:providerServiceId,provider_price:Number(plan.price),customer_price:customerPrice};}
async function resolveDataPlanName(network,planKey){try{const key=clean(planKey);const plans=await fetchVTUGATEDataPlans(network);return clean(plans.find(x=>planLookupKey(x.plan_code||x.code||"",x.service_id)===key||String(x.plan_code||x.code||"")===key)?.name||"");}catch{return "";}}

async function getVTUGATEEducationPrice(serviceId){const r=await vtugateRequest("api/v1/geteducationtypeprice",{service_id:serviceId});if(!r.success)throw new Error(r.message||"Unable to load education PIN price.");return Number(r.data?.data?.price??r.data?.price??0);}
async function getVTUGATEEducationProducts(){
if(Date.now()-vtugateServiceCache.at>300000){const r=await fetchVTUGATEServices(true);if(!r.success)throw new Error(r.message||"Unable to load VTUGATE services.");const raw=Array.isArray(r.data?.data)?r.data.data:(Array.isArray(r.data?.services)?r.data.services:(Array.isArray(r.data)?r.data:[]));vtugateServiceCache.data=raw;vtugateServiceCache.at=Date.now();}
const wanted={waec:"WAEC",neco:"NECO",jamb:"JAMB",nabteb:"NABTEB"};const products=[];
for(const [code,label] of Object.entries(wanted)){
 const item=vtugateServiceCache.data.find(x=>{const hay=[x.name,x.service_name,x.code,x.service_code,x.slug,x.type,x.product_code,x.product].filter(Boolean).join(" ").toLowerCase();return hay.includes(code)||hay.includes(label.toLowerCase());});
 const serviceId=Number(item?.service_id??item?.serviceId??item?.id??0);if(serviceId>0)products.push({service_id:serviceId,product_id:serviceId,product_code:code,name:label,exam_name:label});
}
if(!products.length){const fallback=await getVTUGATEServiceId("education");products.push({service_id:fallback,product_id:fallback,product_code:"waec",name:"WAEC",exam_name:"WAEC"});}
return products;
}
async function getVTUGATETransaction(providerReference){if(!providerReference)return{success:false,outcome:"unknown",message:"Missing provider reference."};const r=await vtugateRequest("api/v1/transactionstatus",{transaction_id:providerReference,reference:providerReference});if(r.outcome==="successful")return{success:true,outcome:"successful",data:r.data,providerReference:r.providerReference||providerReference,message:r.message};if(r.outcome==="failed"||r.outcome==="refunded")return{success:false,outcome:r.outcome,data:r.data,providerReference:r.providerReference||providerReference,message:r.message};return{success:false,outcome:"unknown",data:r.data,providerReference:r.providerReference||providerReference,message:r.message||"VTUGATE transaction status is still unavailable."};}

async function reconcileVTUGATETransactions(){
let rows=[];try{rows=(await db(`SELECT id,provider_reference FROM transactions WHERE status IN ('processing','pending') AND provider_reference IS NOT NULL ORDER BY date ASC LIMIT 100`)).rows;}catch(e){console.error("VTUGATE RECONCILIATION QUERY ERROR:",e);return{success:false,error:e.message};}
let finalized=0,unverified=0;for(const row of rows){try{const r=await getVTUGATETransaction(row.provider_reference);if(r.outcome==="successful"||r.outcome==="failed"||r.outcome==="refunded"){await finalizeVTUTransaction(row.id,r.outcome,r.data||{},r.providerReference||row.provider_reference);finalized++;}else unverified++;}catch(e){unverified++;}}
return{success:true,checked:rows.length,finalized,unverified};
}
async function reconcilePendingTransactions(){return reconcileVTUGATETransactions();}

async function processVTUTransaction(user,data){
const userId=clean(user.user_id);const service=clean(data.service||data.providerPayload?.service).toLowerCase();const amount=Number(data.amount);
if(!userId)return{success:false,statusCode:401,message:"Unauthorized."};
if(!["airtime","data","exam_pin","cable","electricity"].includes(service))return{success:false,statusCode:400,message:"This service is not currently wired to VTUGATE."};
// Enforce the admin panel's per-service Enabled/Maintenance toggle for every
// service at the one place that actually matters — before any wallet debit.
// Previously only Data checked this (as a side effect of its price lookup),
// and Exam PINs only checked it when listing products, never at purchase
// time — so disabling Airtime, Cable TV, or Electricity in admin.html, or
// buying from an already-loaded Exam PIN product page, did not actually
// stop the purchase from going through.
const serviceRecord=await getService(service);
if(!serviceRecord||serviceRecord.enabled===false)return{success:false,statusCode:503,message:"This service is currently unavailable."};
if(serviceRecord.maintenance===true)return{success:false,statusCode:503,message:"This service is currently under maintenance."};
if(!validAmount(amount))return{success:false,statusCode:400,message:"Invalid amount."};
if(["airtime","data","cable","electricity"].includes(service)&&!/^0\d{10}$/.test(clean(data.phone||data.providerPayload?.phone||"08000000000")))return{success:false,statusCode:400,message:"Please enter a valid 11-digit phone number."};
const idem=clean(data.idempotencyKey||data.idempotency_key);const security=await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`,[userId]);if(!security.rows[0]?.transaction_pin_hash)return{success:false,statusCode:400,message:"Please set your Transaction PIN before making a purchase."};const suppliedPin=String(data.transactionPin||"");if(!/^\d{4}$/.test(suppliedPin)||!verifyPassword(suppliedPin,security.rows[0].transaction_pin_hash))return{success:false,statusCode:400,message:"Incorrect Transaction PIN."};
let providerPayload={},recipient=clean(data.phone||data.providerPayload?.phone||user.phone),pricingMeta={providerCost:null,customerPrice:amount,grossProfit:0};
if(service==="data"){
const requestedPlanCode=clean(data.plan_code??data.providerPayload?.plan_code??data.plan_id??data.providerPayload?.plan_id??"");const requestedServiceId=Number(data.service_id??data.providerPayload?.service_id??0);const fallbackLookupKey=clean(data.bundle_id??data.providerPayload?.bundle_id??"");const planCode=(requestedServiceId>0&&requestedPlanCode)?planLookupKey(requestedPlanCode,requestedServiceId):(fallbackLookupKey||requestedPlanCode);const network=normalizeDataNetwork(data.network||data.providerPayload?.network);if(!planCode)return{success:false,statusCode:400,message:"Plan code is required."};let authoritative;try{authoritative=await getAuthoritativeVTUGATEDataPlan(network,planCode);}catch(e){return{success:false,statusCode:503,message:e.message||"Unable to verify the current data plan price."};}if(Math.abs(amount-Number(authoritative.customer_price))>.009)return{success:false,statusCode:400,message:"The selected data plan price has changed. Please refresh the plans and try again."};pricingMeta={providerCost:authoritative.provider_price,customerPrice:authoritative.customer_price,grossProfit:Number((authoritative.customer_price-authoritative.provider_price).toFixed(2)),network:authoritative.network_name,plan:authoritative.name};const providerPlanCode=clean(authoritative.plan_code||authoritative.code||authoritative.provider_code||"");if(!providerPlanCode)return{success:false,statusCode:503,message:"VTUGATE did not return a plan code for the selected data plan."};providerPayload={service_id:Number(authoritative.service_id),code:providerPlanCode,plan_code:providerPlanCode,phone:recipient,phone_number:recipient,msisdn:recipient,amount,ref:null};
}else if(service==="exam_pin"){
const productId=Number(data.product_id||data.providerPayload?.product_id||0),quantity=Number(data.quantity||data.providerPayload?.quantity||1);if(!Number.isInteger(productId)||productId<=0)return{success:false,statusCode:400,message:"Invalid education PIN product."};if(![1,2,5].includes(quantity))return{success:false,statusCode:400,message:"Education PIN quantity must be 1, 2, or 5."};const serviceId=productId;let unitPrice;try{unitPrice=await getVTUGATEEducationPrice(serviceId);}catch(e){return{success:false,statusCode:503,message:e.message||"Unable to verify the current education PIN price."};}const productCode=clean(data.product_code||data.providerPayload?.product_code||data.exam||"waec");const expectedTotal=Number((unitPrice*quantity).toFixed(2));if(Math.abs(amount-expectedTotal)>.009)return{success:false,statusCode:400,message:"The selected education PIN price has changed. Please refresh the products and try again."};pricingMeta={providerCost:Number((unitPrice*quantity).toFixed(2)),customerPrice:expectedTotal,grossProfit:Number((expectedTotal-unitPrice*quantity).toFixed(2)),plan:productCode.toUpperCase()};providerPayload={service_id:serviceId,phone:recipient||user.phone||"08000000000",phone_number:recipient||user.phone||"08000000000",msisdn:recipient||user.phone||"08000000000",quantity,product_code:productCode,ref:null};
}else if(service==="airtime"){
const network=normalizeDataNetwork(data.network||data.providerPayload?.network);if(!network)return{success:false,statusCode:400,message:"Unsupported network."};if(!/^0\d{10}$/.test(recipient))return{success:false,statusCode:400,message:"Please enter a valid 11-digit phone number."};const detectedNetwork=detectNetworkFromPhone(recipient);const networkConfirmed=data.networkConfirmed===true||data.providerPayload?.networkConfirmed===true;if(detectedNetwork&&detectedNetwork!==network&&!networkConfirmed)return{success:false,statusCode:409,message:`This number looks like a ${detectedNetwork} line, but ${network} was selected. Numbers can be ported \u2014 confirm the network and try again.`,detectedNetwork,requiresNetworkConfirmation:true};let serviceId;try{serviceId=await getVTUGATEServiceId("airtime",network);}catch(e){return{success:false,statusCode:503,message:e.message||"Unable to verify the airtime service for this network right now."};}providerPayload={service_id:serviceId,network,amount,phone:recipient,phone_number:recipient,msisdn:recipient,airtime_amount:amount,ref:null};pricingMeta.network=network;
}else if(service==="cable"){
const providerName=clean(data.provider||data.providerPayload?.provider).toUpperCase();let serviceId;try{serviceId=await getVTUGATEServiceId("cable",providerName);}catch(e){return{success:false,statusCode:503,message:e.message||"Unable to verify the cable TV service for this provider right now."};}const plan=clean(data.plan||data.providerPayload?.plan);const iucnumber=clean(data.smartcard||data.providerPayload?.smartcard);if(!plan)return{success:false,statusCode:400,message:"Cable TV plan is required."};if(!/^\d{8,20}$/.test(iucnumber))return{success:false,statusCode:400,message:"Invalid smartcard/IUC number."};const expectedPrice=getCablePlanPrice(providerName,plan);if(expectedPrice===null)return{success:false,statusCode:400,message:"The selected cable TV plan is not recognized."};if(Math.abs(amount-expectedPrice)>.009)return{success:false,statusCode:400,message:"The selected cable TV plan price has changed. Please refresh and try again."};pricingMeta={providerCost:expectedPrice,customerPrice:expectedPrice,grossProfit:0,network:providerName,plan};providerPayload={service_id:serviceId,provider:providerName,iucnumber,smartcard:iucnumber,phone:recipient,phone_number:recipient,msisdn:recipient,plan,package:plan,amount,ref:null};
}else if(service==="electricity"){
const disco=clean(data.provider||data.providerPayload?.provider||data.disco||data.providerPayload?.disco).toLowerCase();if(!disco)return{success:false,statusCode:400,message:"Electricity provider is required."};let serviceId;try{serviceId=await getVTUGATEServiceId("electricity");}catch(e){return{success:false,statusCode:503,message:e.message||"Unable to verify the electricity service right now."};}const meterTypeRaw=clean(data.meterType||data.providerPayload?.meterType||"Prepaid");const meterType=/^postpaid$/i.test(meterTypeRaw)?"Postpaid":"Prepaid";const meterNo=clean(data.meterNumber||data.providerPayload?.meterNumber||data.meter_no);if(meterNo.length<8)return{success:false,statusCode:400,message:"Invalid meter number."};providerPayload={service_id:serviceId,meter_no:meterNo,disco,amount,phone_number:recipient||"08000000000",ref:null};pricingMeta.network=disco.toUpperCase();pricingMeta.plan=meterType;
}
const referenceValue=reference("BOLTIV-TX");providerPayload.ref=referenceValue;const reserved=await createVTUTransactionAndDebit({userId,service,amount,reference:referenceValue,recipient,idempotencyKey:idem,metadata:{provider:"vtugate",request:providerPayload,pricing:pricingMeta}});if(!reserved.success)return{success:false,statusCode:400,message:reserved.message,balance:0};if(reserved.existing){const t=reserved.transaction;const wallet=await getWallet(userId);return{success:t.status==="successful"||t.status==="pending"||t.status==="processing",message:t.status==="successful"?"Transaction already completed.":"Transaction is already being processed.",reference:t.reference,status:t.status,amount:Number(t.amount),providerReference:t.provider_reference,balance:wallet?.balance??0,alreadyProcessed:true};}
let endpoint="";if(service==="airtime")endpoint="api/v1/buyairtime";else if(service==="data")endpoint="api/v1/buydata";else if(service==="exam_pin")endpoint="api/v1/buyeducation";else if(service==="cable")endpoint="api/v1/buycabletv";else if(service==="electricity")endpoint="api/v1/buyelectricity";
let providerResult;try{providerResult=await vtugateRequest(endpoint,providerPayload);}catch(e){providerResult={success:false,outcome:"unknown",statusCode:502,message:"VTUGATE connection could not be confirmed. Your transaction is being verified."};}
if(!providerResult.success)console.error("VTUGATE TRANSACTION FAILED:",JSON.stringify({endpoint,sentPayload:{...providerPayload,ref:providerPayload.ref},providerMessage:providerResult.message,providerRawResponse:providerResult.data}));
const providerData=providerResult.data||{};const providerReference=providerResult.providerReference||findTransactionField(providerData,["transaction_id","external_reference","reference","transactionId","id"])||referenceValue;const finalized=await finalizeVTUTransaction(reserved.transaction.id,providerResult.outcome||"unknown",providerData,providerReference);const wallet=await getWallet(userId);if(finalized.status==="refunded")return{success:false,statusCode:providerResult.statusCode>=500?502:400,message:providerResult.message||"Transaction failed. Your wallet has been refunded.",reference:reserved.transaction.reference,providerReference,balance:wallet?.balance??0,status:"refunded"};const delivery=providerData?.data?.delivery||providerData?.delivery||null;const pins=providerData?.data?.pins||providerData?.pins||delivery?.pins||[];const token=service==="electricity"?(findTransactionField(providerData,["token","meter_token","recharge_token","standard_token","units_token","electricity_token","vend_token"])||delivery?.token||""):"";const units=service==="electricity"?(findTransactionField(providerData,["units","kwh","unit"])||""):"";return{success:true,statusCode:200,message:providerResult.message||(finalized.status==="pending"?"Your transaction is being processed.":"Transaction successful."),reference:reserved.transaction.reference,providerReference,balance:wallet?.balance??reserved.balance,status:finalized.status,providerData,delivery,pins,token,units};
}

async function verifyVTUGATECable(req){const b=await body(req);const providerName=clean(b.provider).toUpperCase();let serviceId;try{serviceId=await getVTUGATEServiceId("cable",providerName);}catch(e){return{success:false,statusCode:503,message:e.message||"Unable to verify the cable TV service for this provider right now."};}const iucnumber=clean(b.smartcard||b.iucnumber);if(!/^\d{8,20}$/.test(iucnumber))return{success:false,statusCode:400,message:"Invalid smartcard/IUC number."};const phoneVal=clean(b.phone||"08000000000");return vtugateRequest("api/v1/verifycabletv",{service_id:serviceId,provider:providerName,iucnumber,smartcard:iucnumber,phone:phoneVal,phone_number:phoneVal,msisdn:phoneVal});}
async function verifyVTUGATEElectricity(req){const b=await body(req);const disco=clean(b.provider||b.disco).toLowerCase();if(!disco)return{success:false,statusCode:400,message:"Electricity provider is required."};let serviceId;try{serviceId=await getVTUGATEServiceId("electricity");}catch(e){return{success:false,statusCode:503,message:e.message||"Unable to verify the electricity service right now."};}const meterNo=clean(b.meterNumber||b.meter_no||b.meternumber);if(meterNo.length<8)return{success:false,statusCode:400,message:"Invalid meter number."};const result=await vtugateRequest("api/v1/verifyelectricity",{service_id:serviceId,meter_no:meterNo,disco});if(!result.success)return result;const customerName=findTransactionField(result.data,["meter_name","customer_name","name"]);const address=findTransactionField(result.data,["cust_address","address"]);return{...result,customerName,address};}

async function debitWallet(userId,amount){
const client=await pool.connect();
try{await client.query("BEGIN");await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[userId]);const r=await client.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`,[amount,userId]);if(!r.rows.length){await client.query("ROLLBACK");return {success:false,message:"Insufficient wallet balance."};}await client.query("COMMIT");return {success:true,balance:Number(r.rows[0].balance)};}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}

async function createVTUTransactionAndDebit(data){
const client=await pool.connect();
try{
await client.query("BEGIN");
await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[data.userId]);
if(data.idempotencyKey){
const existing=await client.query(`SELECT id,reference,status,amount,provider_reference FROM transactions WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1 FOR UPDATE`,[data.userId,data.idempotencyKey]);
if(existing.rows.length){await client.query("COMMIT");return {success:true,existing:true,transaction:existing.rows[0]};}
}
const wallet=await client.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`,[data.amount,data.userId]);
if(!wallet.rows.length){await client.query("ROLLBACK");return {success:false,message:"Insufficient wallet balance."};}
await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:data.userId,direction:"debit",amount:-Number(data.amount),balanceAfter:Number(wallet.rows[0].balance),reference:`WALLET-DEBIT-${data.reference}`,category:"vtu_debit",description:`Wallet debit for ${data.service}`,metadata:{service:data.service,recipient:data.recipient||null}});
let inserted;
try{
inserted=await client.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,recipient,metadata,idempotency_key,provider_reference) VALUES($1,'debit',$2,$3,$4,'processing',$5,$6::jsonb,$7,$8) RETURNING id,reference,status,amount,provider_reference`,[data.userId,data.service,data.amount,data.reference,data.recipient||null,JSON.stringify(data.metadata||{}),data.idempotencyKey||null,data.providerReference||null]);
await client.query(`UPDATE financial_ledger SET transaction_id=$1 WHERE reference=$2`,[inserted.rows[0].id,`WALLET-DEBIT-${data.reference}`]);
}catch(e){
if(e.code==="23505"&&data.idempotencyKey){const existing=await client.query(`SELECT id,reference,status,amount,provider_reference FROM transactions WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1 FOR UPDATE`,[data.userId,data.idempotencyKey]);if(existing.rows.length){await client.query("ROLLBACK");return {success:true,existing:true,transaction:existing.rows[0]};}}
throw e;
}
await client.query("COMMIT");
return {success:true,existing:false,transaction:inserted.rows[0],balance:Number(wallet.rows[0].balance)};
}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}

async function finalizeVTUTransaction(transactionId,outcome,providerData={},providerReference=null){
const client=await pool.connect();
try{
await client.query("BEGIN");
const q=await client.query(`SELECT * FROM transactions WHERE id=$1 FOR UPDATE`,[transactionId]);
if(!q.rows.length){await client.query("ROLLBACK");return {success:false,message:"Transaction not found."};}
const tx=q.rows[0];
const ref=providerReference||tx.provider_reference||providerData.reference||providerData.transaction_id||providerData.data?.reference||providerData.data?.transaction_id||null;
if(tx.status==="successful"){await client.query("COMMIT");return {success:true,status:"successful",alreadyFinal:true};}
if(tx.status==="refunded"){await client.query("COMMIT");return {success:true,status:"refunded",alreadyFinal:true};}
if(outcome==="successful"){
await client.query(`UPDATE transactions SET status='successful',provider_reference=COALESCE(provider_reference,$2),completed_at=NOW(),last_provider_status='successful',metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[transactionId,ref,JSON.stringify({provider_response:providerData})]);
const fresh=(await client.query(`SELECT * FROM transactions WHERE id=$1`,[transactionId])).rows[0];
await recordRevenueSale(client,fresh);
await client.query("COMMIT");
// Notifications are created after the transaction commit so a notification
// failure can never roll back a successful customer purchase.
try{
  const meta=fresh.metadata&&typeof fresh.metadata==="object"?fresh.metadata:{};
  let detail=`Your ${String(fresh.service||"service")} purchase of ₦${Number(fresh.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
  if(String(fresh.service).toLowerCase()==="data"){
    const network=clean(meta.network||meta.network_provider||"");
    const plan=clean(meta.plan||meta.plan_name||"");
    if(network||plan)detail=`Your ${network||"Data"} ${plan||"data plan"} purchase of ₦${Number(fresh.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
  }
  await addNotificationOnce(fresh.user_id,"Transaction successful",detail,"transaction",`tx-success-${fresh.id}`);
}catch(error){console.error("TRANSACTION NOTIFICATION ERROR:",error?.stack||error?.message||error);}
try{ await sendTransactionEmail(fresh.user_id,fresh,"successful"); }catch(error){ console.error("TRANSACTION EMAIL HOOK ERROR:",error?.stack||error?.message||error); }
return {success:true,status:"successful"};
}
if(outcome==="failed"||outcome==="refunded"){
if(!tx.refunded_at){
const wr=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[Number(tx.amount),tx.user_id]);
if(!wr.rows.length)throw new Error("Wallet could not be credited for refund.");
await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:tx.user_id,direction:"credit",amount:Number(tx.amount),balanceAfter:Number(wr.rows[0].balance),reference:`WALLET-REFUND-${tx.reference}`,transactionId:tx.id,category:"vtu_refund",description:`Refund for ${tx.service}`,metadata:{reason:outcome}});
}
await client.query(`UPDATE transactions SET status='refunded',provider_reference=COALESCE(provider_reference,$2),refunded_at=COALESCE(refunded_at,NOW()),completed_at=COALESCE(completed_at,NOW()),last_provider_status=$4,refund_reason=$5,metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[transactionId,ref,JSON.stringify({provider_response:providerData,refund_reason:outcome}),outcome,outcome]);
const fresh=(await client.query(`SELECT * FROM transactions WHERE id=$1`,[transactionId])).rows[0];
if(!tx.refunded_at)await recordRevenueRefund(client,fresh);
await client.query("COMMIT");if(!tx.refunded_at){try{await addNotificationOnce(tx.user_id,"Transaction refunded",`Your ${String(tx.service||"service")} transaction of ₦${Number(tx.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} could not be completed. The amount has been returned to your wallet.` ,"transaction",`tx-refund-${tx.id}`);}catch{}}
if(!tx.refunded_at){try{await sendTransactionEmail(tx.user_id,fresh,"refunded");}catch(error){console.error("REFUND EMAIL HOOK ERROR:",error?.stack||error?.message||error);}}
return {success:true,status:"refunded",refunded:!tx.refunded_at};
}
await client.query(`UPDATE transactions SET status='pending',provider_reference=COALESCE(provider_reference,$2),last_provider_status='pending',metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[transactionId,ref,JSON.stringify({provider_response:providerData})]);
await client.query("COMMIT");return {success:true,status:"pending"};
}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}

async function refundWallet(userId,amount){
await db(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2`,[amount,userId]);
}

async function insertVTUTransaction(data){
await db(`INSERT INTO transactions(user_id,type,service,amount,reference,status,recipient,metadata,idempotency_key,provider_reference,completed_at,refunded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) ON CONFLICT(reference) DO NOTHING`,[data.userId,data.type||"debit",data.service,data.amount,data.reference,data.status,data.recipient||null,JSON.stringify(data.metadata||{}),data.idempotencyKey||null,data.providerReference||null,data.status==="successful"?new Date():null,data.status==="failed"?new Date():null]);
}

async function adminRefund(req){
const check=await requireAdminCsrf(req);if(!check.success)return check;
const b=await body(req);const ref=clean(b.reference);const reason=clean(b.reason)||"Admin approved refund";
if(!ref)return {success:false,statusCode:400,message:"Transaction reference is required."};
const client=await pool.connect();
try{await client.query("BEGIN");const q=await client.query(`SELECT * FROM transactions WHERE reference=$1 FOR UPDATE`,[ref]);if(!q.rows.length){await client.query("ROLLBACK");return {success:false,statusCode:404,message:"Transaction not found."};}const tx=q.rows[0];if(tx.type!=="debit"){await client.query("ROLLBACK");return {success:false,statusCode:400,message:"Only debit transactions can be refunded."};}if(tx.status==="successful"||tx.status==="pending"||tx.status==="processing"){if(!tx.refunded_at){const wr=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[Number(tx.amount),tx.user_id]);if(!wr.rows.length)throw new Error("Wallet could not be credited.");await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:tx.user_id,direction:"credit",amount:Number(tx.amount),balanceAfter:Number(wr.rows[0].balance),reference:`WALLET-ADMIN-REFUND-${tx.reference}`,transactionId:tx.id,category:"admin_refund",description:`Admin refund for ${tx.service}`,metadata:{reason,admin_id:check.admin.id}});await recordRevenueRefund(client,tx);}await client.query(`UPDATE transactions SET status='refunded',refunded_at=COALESCE(refunded_at,NOW()),completed_at=COALESCE(completed_at,NOW()),metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[tx.id,JSON.stringify({admin_refund:true,reason,admin_id:check.admin.id})]);}else if(tx.status==="refunded"){await client.query("COMMIT");return {success:true,alreadyRefunded:true,message:"Transaction was already refunded."};}else{await client.query("ROLLBACK");return {success:false,statusCode:400,message:"This transaction cannot be refunded in its current state."};}await client.query("COMMIT");return {success:true,message:"Transaction refunded successfully."};}catch(e){try{await client.query("ROLLBACK")}catch{};return {success:false,statusCode:500,message:"Refund failed."};}finally{client.release();}
}

function token(){
return crypto.randomBytes(32).toString("hex");
}

function reference(prefix="BOLTIV"){
return `${prefix}-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
}

function makeUserId(){
return crypto.randomUUID();
}

function hashPassword(
password,
salt=crypto.randomBytes(16).toString("hex")
){

const hash=crypto.scryptSync(
password,
salt,
64
).toString("hex");

return `${salt}:${hash}`;
}

function verifyPassword(
password,
stored
){

try{

const parts=
String(stored||"").split(":");

if(parts.length!==2){
return false;
}

const hash=
crypto.scryptSync(
password,
parts[0],
64
);

const saved=
Buffer.from(
parts[1],
"hex"
);

if(hash.length!==saved.length){
return false;
}

return crypto.timingSafeEqual(
hash,
saved
);

}catch(error){

console.error(
"PASSWORD VERIFY ERROR:",
error.message
);

return false;
}

}

/* =========================================================
   WEBAUTHN (BIOMETRIC UNLOCK)
   ---------------------------------------------------------
   Minimal, dependency-free WebAuthn relying-party implementation using only
   Node's built-in crypto. No npm package is used here — this environment has
   no network access to install one, and the protocol pieces needed for our
   scope (registration + assertion verification for an already-logged-in
   user, attestation format "none"/unchecked) are small enough to implement
   directly and correctly:
     - a minimal CBOR decoder (COSE keys and attestationObject use a
       constrained, predictable subset of CBOR: maps, byte strings, text
       strings, integers)
     - authenticatorData binary parsing (fixed layout per the WebAuthn spec)
     - COSE key -> Node KeyObject (via JWK, for EC2/P-256 and RSA)
     - ECDSA/RSA signature verification of the assertion
   The actual biometric (fingerprint/face) never leaves the user's device —
   only a signature proving the correct platform authenticator was used
   reaches this server, which is the whole point of WebAuthn.
   ========================================================= */

const RP_ID=(()=>{try{return new URL(FRONTEND_URL).hostname;}catch(e){return "boltiv.ng";}})();
const RP_NAME="BOLTIV";
const EXPECTED_ORIGIN=FRONTEND_URL;

function base64url(buf){return Buffer.from(buf).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");}
function fromBase64url(str){str=String(str||"").replace(/-/g,"+").replace(/_/g,"/");while(str.length%4)str+="=";return Buffer.from(str,"base64");}

/* --- minimal CBOR decoder (decode only; enough for COSE keys + attestationObject) --- */
function cborDecode(buf,offset=0){
  const view=buf;
  function readUInt(firstByteInfo,off){
    if(firstByteInfo<24)return {value:firstByteInfo,next:off};
    if(firstByteInfo===24)return {value:view.readUInt8(off),next:off+1};
    if(firstByteInfo===25)return {value:view.readUInt16BE(off),next:off+2};
    if(firstByteInfo===26)return {value:view.readUInt32BE(off),next:off+4};
    if(firstByteInfo===27){
      const hi=view.readUInt32BE(off),lo=view.readUInt32BE(off+4);
      return {value:hi*4294967296+lo,next:off+8};
    }
    throw new Error("CBOR: unsupported length encoding");
  }
  function decodeAt(off){
    const first=view.readUInt8(off);
    const majorType=first>>5;
    const info=first&0x1f;
    off+=1;
    if(majorType===0){ // unsigned int
      const r=readUInt(info,off);
      return {value:r.value,next:r.next};
    }
    if(majorType===1){ // negative int
      const r=readUInt(info,off);
      return {value:-1-r.value,next:r.next};
    }
    if(majorType===2){ // byte string
      const r=readUInt(info,off);
      const bytes=view.slice(r.next,r.next+r.value);
      return {value:bytes,next:r.next+r.value};
    }
    if(majorType===3){ // text string
      const r=readUInt(info,off);
      const str=view.slice(r.next,r.next+r.value).toString("utf8");
      return {value:str,next:r.next+r.value};
    }
    if(majorType===4){ // array
      const r=readUInt(info,off);
      let cur=r.next;
      const arr=[];
      for(let i=0;i<r.value;i++){const d=decodeAt(cur);arr.push(d.value);cur=d.next;}
      return {value:arr,next:cur};
    }
    if(majorType===5){ // map
      const r=readUInt(info,off);
      let cur=r.next;
      const map=new Map();
      for(let i=0;i<r.value;i++){
        const k=decodeAt(cur);cur=k.next;
        const v=decodeAt(cur);cur=v.next;
        map.set(k.value,v.value);
      }
      return {value:map,next:cur};
    }
    if(majorType===7){ // simple/float
      if(info===20)return {value:false,next:off};
      if(info===21)return {value:true,next:off};
      if(info===22)return {value:null,next:off};
      throw new Error("CBOR: unsupported simple value");
    }
    throw new Error("CBOR: unsupported major type "+majorType);
  }
  return decodeAt(offset);
}

/* --- COSE key (decoded CBOR map) -> Node crypto public KeyObject, via JWK --- */
function coseKeyToPublicKeyObject(coseMap){
  const kty=coseMap.get(1);
  if(kty===2){ // EC2
    const crv=coseMap.get(-1);
    const x=coseMap.get(-2);
    const y=coseMap.get(-3);
    if(crv!==1)throw new Error("Unsupported EC curve (only P-256 is supported).");
    const jwk={kty:"EC",crv:"P-256",x:base64url(x),y:base64url(y)};
    return {keyObject:crypto.createPublicKey({key:jwk,format:"jwk"}),jwk,alg:-7};
  }
  if(kty===3){ // RSA
    const n=coseMap.get(-1);
    const e=coseMap.get(-2);
    const jwk={kty:"RSA",n:base64url(n),e:base64url(e)};
    return {keyObject:crypto.createPublicKey({key:jwk,format:"jwk"}),jwk,alg:-257};
  }
  throw new Error("Unsupported public key type.");
}

function publicKeyObjectFromStoredJwk(jwk){
  return crypto.createPublicKey({key:jwk,format:"jwk"});
}

/* --- authenticatorData binary layout (WebAuthn spec §6.1) --- */
function parseAuthenticatorData(authData){
  if(authData.length<37)throw new Error("authenticatorData too short.");
  const rpIdHash=authData.slice(0,32);
  const flags=authData.readUInt8(32);
  const signCount=authData.readUInt32BE(33);
  let offset=37;
  let credentialId=null,publicKeyJwk=null,publicKeyObject=null;
  const attestedCredentialDataIncluded=Boolean(flags&0x40);
  if(attestedCredentialDataIncluded){
    offset+=16; // aaguid
    const credIdLen=authData.readUInt16BE(offset);offset+=2;
    credentialId=authData.slice(offset,offset+credIdLen);offset+=credIdLen;
    const decoded=cborDecode(authData,offset);
    offset=decoded.next;
    const parsedKey=coseKeyToPublicKeyObject(decoded.value);
    publicKeyJwk=parsedKey.jwk;
    publicKeyObject=parsedKey.keyObject;
  }
  return {
    rpIdHash,
    userPresent:Boolean(flags&0x01),
    userVerified:Boolean(flags&0x04),
    signCount,
    credentialId,
    publicKeyJwk,
    publicKeyObject
  };
}

async function createWebAuthnChallenge(userId,purpose){
  const challenge=base64url(crypto.randomBytes(32));
  await db(`DELETE FROM webauthn_challenges WHERE user_id=$1 AND purpose=$2`,[userId,purpose]);
  await db(`INSERT INTO webauthn_challenges(user_id,purpose,challenge,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '3 minutes')`,[userId,purpose,challenge]);
  return challenge;
}
async function consumeWebAuthnChallenge(userId,purpose,submittedChallenge){
  const r=await db(`DELETE FROM webauthn_challenges WHERE user_id=$1 AND purpose=$2 AND expires_at>NOW() RETURNING challenge`,[userId,purpose]);
  if(!r.rows.length)return false;
  return r.rows[0].challenge===submittedChallenge;
}

async function webauthnRegistrationOptions(user){
  const challenge=await createWebAuthnChallenge(user.user_id,"register");
  const existing=await db(`SELECT credential_id FROM webauthn_credentials WHERE user_id=$1`,[user.user_id]);
  return{
    success:true,
    options:{
      rp:{name:RP_NAME,id:RP_ID},
      user:{id:base64url(Buffer.from(String(user.user_id))),name:user.email||user.user_id,displayName:user.name||user.email||"BOLTIV User"},
      challenge,
      pubKeyCredParams:[{type:"public-key",alg:-7},{type:"public-key",alg:-257}],
      authenticatorSelection:{authenticatorAttachment:"platform",userVerification:"required",residentKey:"discouraged"},
      timeout:60000,
      attestation:"none",
      excludeCredentials:existing.rows.map(r=>({type:"public-key",id:r.credential_id}))
    }
  };
}

async function webauthnRegistrationVerify(user,credential,deviceLabel){
  const clientDataJSON=fromBase64url(credential?.response?.clientDataJSON);
  const attestationObject=fromBase64url(credential?.response?.attestationObject);
  const rawCredentialId=fromBase64url(credential?.id);
  if(!clientDataJSON.length||!attestationObject.length||!rawCredentialId.length){
    return{success:false,statusCode:400,message:"Invalid biometric registration response."};
  }
  let clientData;
  try{clientData=JSON.parse(clientDataJSON.toString("utf8"));}
  catch(e){return{success:false,statusCode:400,message:"Invalid biometric registration response."};}
  if(clientData.type!=="webauthn.create")return{success:false,statusCode:400,message:"Unexpected registration ceremony type."};
  if(clientData.origin!==EXPECTED_ORIGIN)return{success:false,statusCode:400,message:"Registration origin mismatch."};
  const ok=await consumeWebAuthnChallenge(user.user_id,"register",clientData.challenge);
  if(!ok)return{success:false,statusCode:400,message:"This registration request expired. Please try again."};

  let attestation;
  try{attestation=cborDecode(attestationObject,0).value;}
  catch(e){return{success:false,statusCode:400,message:"Unable to parse the authenticator response."};}
  const authDataBuf=attestation.get("authData");
  if(!authDataBuf)return{success:false,statusCode:400,message:"Authenticator did not return credential data."};

  let parsed;
  try{parsed=parseAuthenticatorData(authDataBuf);}
  catch(e){return{success:false,statusCode:400,message:"Unable to parse authenticator data."};}

  const expectedRpIdHash=crypto.createHash("sha256").update(RP_ID).digest();
  if(!parsed.rpIdHash.equals(expectedRpIdHash))return{success:false,statusCode:400,message:"Authenticator is not registered for this site."};
  if(!parsed.userPresent)return{success:false,statusCode:400,message:"User presence was not confirmed by the authenticator."};
  if(!parsed.credentialId||!parsed.publicKeyJwk)return{success:false,statusCode:400,message:"No credential was returned by the authenticator."};

  const credentialIdB64=base64url(parsed.credentialId);
  const dupe=await db(`SELECT id FROM webauthn_credentials WHERE credential_id=$1`,[credentialIdB64]);
  if(dupe.rows.length)return{success:false,statusCode:409,message:"This authenticator is already registered."};

  await db(`INSERT INTO webauthn_credentials(user_id,credential_id,public_key_jwk,sign_count,device_label) VALUES($1,$2,$3::jsonb,$4,$5)`,
    [user.user_id,credentialIdB64,JSON.stringify(parsed.publicKeyJwk),parsed.signCount,clean(deviceLabel)||"This device"]);
  try{await addNotification(user.user_id,"Biometric unlock added","A new device was enrolled for biometric unlock on your BOLTIV account.","security");}catch{}
  return{success:true,message:"Biometric unlock enabled for this device."};
}

async function webauthnAuthenticationOptions(user){
  const creds=await db(`SELECT credential_id FROM webauthn_credentials WHERE user_id=$1`,[user.user_id]);
  if(!creds.rows.length)return{success:false,statusCode:404,message:"No biometric credential is registered on this account."};
  const challenge=await createWebAuthnChallenge(user.user_id,"authenticate");
  return{
    success:true,
    options:{
      rpId:RP_ID,
      challenge,
      timeout:60000,
      userVerification:"required",
      allowCredentials:creds.rows.map(r=>({type:"public-key",id:r.credential_id}))
    }
  };
}

async function webauthnAuthenticationVerify(user,credential){
  const clientDataJSON=fromBase64url(credential?.response?.clientDataJSON);
  const authenticatorData=fromBase64url(credential?.response?.authenticatorData);
  const signature=fromBase64url(credential?.response?.signature);
  const credentialIdB64=String(credential?.id||"");
  if(!clientDataJSON.length||!authenticatorData.length||!signature.length||!credentialIdB64){
    return{success:false,statusCode:400,message:"Invalid biometric response."};
  }
  let clientData;
  try{clientData=JSON.parse(clientDataJSON.toString("utf8"));}
  catch(e){return{success:false,statusCode:400,message:"Invalid biometric response."};}
  if(clientData.type!=="webauthn.get")return{success:false,statusCode:400,message:"Unexpected authentication ceremony type."};
  if(clientData.origin!==EXPECTED_ORIGIN)return{success:false,statusCode:400,message:"Authentication origin mismatch."};
  const ok=await consumeWebAuthnChallenge(user.user_id,"authenticate",clientData.challenge);
  if(!ok)return{success:false,statusCode:400,message:"This biometric prompt expired. Please try again."};

  const row=(await db(`SELECT id,public_key_jwk,sign_count FROM webauthn_credentials WHERE user_id=$1 AND credential_id=$2`,[user.user_id,credentialIdB64])).rows[0];
  if(!row)return{success:false,statusCode:404,message:"This device is not registered for biometric unlock."};

  let parsed;
  try{parsed=parseAuthenticatorData(authenticatorData);}
  catch(e){return{success:false,statusCode:400,message:"Unable to parse authenticator data."};}
  const expectedRpIdHash=crypto.createHash("sha256").update(RP_ID).digest();
  if(!parsed.rpIdHash.equals(expectedRpIdHash))return{success:false,statusCode:400,message:"Authenticator is not registered for this site."};
  if(!parsed.userPresent)return{success:false,statusCode:400,message:"User presence was not confirmed by the authenticator."};

  let publicKeyObject;
  try{publicKeyObject=publicKeyObjectFromStoredJwk(row.public_key_jwk);}
  catch(e){return{success:false,statusCode:500,message:"Stored credential is invalid."};}

  const signedData=Buffer.concat([authenticatorData,crypto.createHash("sha256").update(clientDataJSON).digest()]);
  let verified=false;
  try{
    const alg=row.public_key_jwk.kty==="RSA"?"RSA-SHA256":"sha256";
    verified=crypto.verify(alg,signedData,publicKeyObject,signature);
  }catch(e){verified=false;}
  if(!verified)return{success:false,statusCode:401,message:"Biometric verification failed."};

  if(Number(parsed.signCount)>0&&Number(parsed.signCount)<=Number(row.sign_count)){
    // Signature counter went backwards or didn't increase — a sign a cloned
    // authenticator may be in use. Refuse rather than silently accept.
    return{success:false,statusCode:401,message:"Biometric verification failed. Please use your PIN."};
  }
  await db(`UPDATE webauthn_credentials SET sign_count=$1,last_used_at=NOW() WHERE id=$2`,[parsed.signCount,row.id]);
  return{success:true};
}

async function setup(){

if(!DATABASE_URL){

console.log(
"DATABASE_URL is not configured."
);

return;
}

await db(`
CREATE TABLE IF NOT EXISTS users(
id BIGSERIAL PRIMARY KEY,
user_id TEXT UNIQUE,
name TEXT,
phone TEXT NOT NULL,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS user_id TEXT`
);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS name TEXT`
);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS phone TEXT`
);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS password_hash TEXT`
);

await db(
`ALTER TABLE users
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`
);
await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`);
await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`);
await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT`);
await db(`CREATE INDEX IF NOT EXISTS users_status_idx ON users(status)`);
await db(`
CREATE TABLE IF NOT EXISTS email_verification_tokens(
id BIGSERIAL PRIMARY KEY,
user_id BIGINT NOT NULL,
token_hash TEXT UNIQUE NOT NULL,
expires_at TIMESTAMPTZ NOT NULL,
used BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens(user_id)`);
await db(`CREATE INDEX IF NOT EXISTS email_verification_tokens_expiry_idx ON email_verification_tokens(expires_at)`);

await db(`
CREATE TABLE IF NOT EXISTS user_sessions(
token TEXT PRIMARY KEY,
user_id BIGINT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
expires_at TIMESTAMPTZ NOT NULL
)`);

await db(`
CREATE TABLE IF NOT EXISTS wallets(
user_id TEXT PRIMARY KEY,
balance NUMERIC(14,2) NOT NULL DEFAULT 0,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`
CREATE TABLE IF NOT EXISTS transactions(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
type TEXT NOT NULL,
service TEXT NOT NULL,
amount NUMERIC(14,2) NOT NULL,
reference TEXT UNIQUE,
status TEXT NOT NULL,
date TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_reference TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recipient TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS metadata JSONB`);
await db(`CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency_idx ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
await db(`CREATE INDEX IF NOT EXISTS transactions_status_idx ON transactions(status)`);
await db(`CREATE INDEX IF NOT EXISTS transactions_provider_reference_idx ON transactions(provider_reference) WHERE provider_reference IS NOT NULL`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_reason TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS last_provider_status TEXT`);
await db(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_attempts INTEGER NOT NULL DEFAULT 0`);
await db(`
CREATE TABLE IF NOT EXISTS user_security(
user_id TEXT PRIMARY KEY,
transaction_pin_hash TEXT,
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`
CREATE TABLE IF NOT EXISTS webauthn_credentials(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
credential_id TEXT UNIQUE NOT NULL,
public_key_jwk JSONB NOT NULL,
sign_count BIGINT NOT NULL DEFAULT 0,
device_label TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
last_used_at TIMESTAMPTZ
)`);
await db(`CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx ON webauthn_credentials(user_id)`);

await db(`
CREATE TABLE IF NOT EXISTS webauthn_challenges(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
purpose TEXT NOT NULL,
challenge TEXT NOT NULL,
expires_at TIMESTAMPTZ NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS webauthn_challenges_user_idx ON webauthn_challenges(user_id,purpose)`);

await db(`
CREATE TABLE IF NOT EXISTS support_tickets(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
subject TEXT NOT NULL,
message TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'open',
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS transaction_reference TEXT`);
await db(`CREATE INDEX IF NOT EXISTS support_tickets_transaction_ref_idx ON support_tickets(transaction_reference) WHERE transaction_reference IS NOT NULL`);

await db(`
CREATE TABLE IF NOT EXISTS notifications(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
title TEXT NOT NULL,
message TEXT NOT NULL,
type TEXT NOT NULL DEFAULT 'info',
read BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT`);
// Ensure the dedupe index can be created even if an earlier deployment inserted
// duplicate backfill keys. Keep the oldest notification for each key.
await db(`
  DELETE FROM notifications n
  USING notifications newer
  WHERE n.dedupe_key IS NOT NULL
    AND n.dedupe_key = newer.dedupe_key
    AND n.id > newer.id
`);
await db(`CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL`);

await db(`
CREATE TABLE IF NOT EXISTS payments(
id BIGSERIAL PRIMARY KEY,
reference TEXT UNIQUE NOT NULL,
user_id TEXT NOT NULL,
email TEXT NOT NULL,
amount NUMERIC(14,2) NOT NULL,
amount_kobo BIGINT NOT NULL,
status TEXT NOT NULL,
credited BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
credited_at TIMESTAMPTZ
)`);
await db(`
CREATE TABLE IF NOT EXISTS flutterwave_virtual_accounts(
id BIGSERIAL PRIMARY KEY,
owner_type TEXT NOT NULL DEFAULT 'user',
owner_id TEXT NOT NULL,
account_type TEXT NOT NULL DEFAULT 'static',
account_number TEXT UNIQUE NOT NULL,
account_name TEXT,
bank_name TEXT,
bank_code TEXT,
currency TEXT NOT NULL DEFAULT 'NGN',
amount NUMERIC(14,2) NOT NULL DEFAULT 0,
status TEXT NOT NULL DEFAULT 'active',
provider_account_id TEXT,
provider_customer_id TEXT,
tx_ref TEXT UNIQUE,
identity_type TEXT,
expiry_date TIMESTAMPTZ,
metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS flutterwave_va_account_idx ON flutterwave_virtual_accounts(account_number)`);
await db(`CREATE INDEX IF NOT EXISTS flutterwave_va_owner_idx ON flutterwave_virtual_accounts(owner_type,owner_id,created_at DESC)`);
await db(`CREATE UNIQUE INDEX IF NOT EXISTS flutterwave_static_owner_idx ON flutterwave_virtual_accounts(owner_type,owner_id) WHERE account_type='static'`);

await db(`
CREATE TABLE IF NOT EXISTS flutterwave_webhook_events(
id BIGSERIAL PRIMARY KEY,
event_id TEXT UNIQUE NOT NULL,
event_type TEXT,
payload JSONB NOT NULL,
processed BOOLEAN NOT NULL DEFAULT FALSE,
processed_at TIMESTAMPTZ,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`
CREATE TABLE IF NOT EXISTS admins(
id BIGSERIAL PRIMARY KEY,
email TEXT UNIQUE NOT NULL,
password_hash TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`
CREATE TABLE IF NOT EXISTS admin_sessions(
token TEXT PRIMARY KEY,
admin_id BIGINT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
expires_at TIMESTAMPTZ NOT NULL
)`);
// Backward-compatible migration for existing Boltiv databases.
await db(`ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT`);
await db(`CREATE TABLE IF NOT EXISTS admin_wallets(admin_id BIGINT PRIMARY KEY,balance NUMERIC(14,2) NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS admin_wallet_ledger(id BIGSERIAL PRIMARY KEY,admin_id BIGINT NOT NULL,type TEXT NOT NULL,amount NUMERIC(14,2) NOT NULL,balance_after NUMERIC(14,2) NOT NULL,reference TEXT UNIQUE NOT NULL,description TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS admin_wallet_ledger_admin_idx ON admin_wallet_ledger(admin_id,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS admin_profit_withdrawals(
id BIGSERIAL PRIMARY KEY,
admin_id BIGINT NOT NULL,
amount NUMERIC(14,2) NOT NULL,
bank_code TEXT NOT NULL,
account_number TEXT NOT NULL,
account_name TEXT NOT NULL,
status TEXT NOT NULL DEFAULT 'pending',
reference TEXT UNIQUE NOT NULL,
provider_transfer_id TEXT,
provider_reference TEXT,
provider_message TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
completed_at TIMESTAMPTZ
)`);
await db(`CREATE INDEX IF NOT EXISTS admin_profit_withdrawals_admin_idx ON admin_profit_withdrawals(admin_id,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS admin_revenue_wallets(admin_id BIGINT PRIMARY KEY,balance NUMERIC(14,2) NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS admin_revenue_ledger(id BIGSERIAL PRIMARY KEY,admin_id BIGINT NOT NULL,type TEXT NOT NULL,amount NUMERIC(14,2) NOT NULL,balance_after NUMERIC(14,2) NOT NULL,reference TEXT UNIQUE NOT NULL,description TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS admin_revenue_ledger_admin_idx ON admin_revenue_ledger(admin_id,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS admin_revenue_withdrawals(id BIGSERIAL PRIMARY KEY,admin_id BIGINT NOT NULL,amount NUMERIC(14,2) NOT NULL,bank_code TEXT NOT NULL,account_number TEXT NOT NULL,account_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reference TEXT UNIQUE NOT NULL,recipient_code TEXT,provider_transfer_id TEXT,provider_message TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`);
await db(`CREATE INDEX IF NOT EXISTS admin_revenue_withdrawals_admin_idx ON admin_revenue_withdrawals(admin_id,created_at DESC)`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS recipient_type TEXT NOT NULL DEFAULT 'user'`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS admin_id BIGINT`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS email TEXT`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2) DEFAULT 0`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_kobo BIGINT DEFAULT 0`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS credited BOOLEAN DEFAULT FALSE`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
await db(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ`);
await db(`UPDATE payments p SET email=COALESCE(NULLIF(p.email,''),u.email) FROM users u WHERE u.user_id=p.user_id AND (p.email IS NULL OR p.email='')`);
await db(`CREATE TABLE IF NOT EXISTS admin_audit_logs(
id BIGSERIAL PRIMARY KEY,
admin_id BIGINT,
action TEXT NOT NULL,
target_type TEXT,
target_id TEXT,
details JSONB,
ip TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_logs(created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS support_messages(
id BIGSERIAL PRIMARY KEY,
ticket_id BIGINT NOT NULL,
sender_type TEXT NOT NULL,
sender_id TEXT,
message TEXT NOT NULL,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages(ticket_id,created_at)`);

await db(`CREATE TABLE IF NOT EXISTS platform_settings(key TEXT PRIMARY KEY,value JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS services(key TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT,enabled BOOLEAN NOT NULL DEFAULT TRUE,fee NUMERIC(14,2) NOT NULL DEFAULT 0,maintenance BOOLEAN NOT NULL DEFAULT FALSE,config JSONB NOT NULL DEFAULT '{}'::jsonb,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS icon TEXT`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS fee NUMERIC(14,2) NOT NULL DEFAULT 0`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS maintenance BOOLEAN NOT NULL DEFAULT FALSE`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb`);
await db(`ALTER TABLE services ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
await db(`CREATE TABLE IF NOT EXISTS security_events(id BIGSERIAL PRIMARY KEY,admin_id BIGINT,event_type TEXT NOT NULL,severity TEXT NOT NULL DEFAULT 'info',details JSONB,ip TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events(created_at DESC)`);
for(const [key,name,icon] of [['airtime','Airtime','📱'],['data','Data','🌐'],['electricity','Electricity','💡'],['cable','Cable TV','📺'],['exam_pin','Exam PINs','🎓']]) await db(`INSERT INTO services(key,name,icon) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`,[key,name,icon]);
await db(`UPDATE services SET enabled=FALSE,maintenance=TRUE,updated_at=NOW() WHERE key NOT IN ('airtime','data','electricity','cable','exam_pin')`);
await db(`DELETE FROM services WHERE key IN ('education','betting','sms')`);
for(const [key,value] of [['maintenance_mode',false],['registration_enabled',true],['announcement_enabled',true],['announcement_text','Welcome to BOLTIV — Fast. Simple. Powerful.'],['announcement_items',[{text:'Welcome to BOLTIV — Fast. Simple. Powerful.',enabled:true}]]]) await db(`INSERT INTO platform_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING`,[key,JSON.stringify(value)]);

await db(`
CREATE TABLE IF NOT EXISTS password_reset_tokens(
id BIGSERIAL PRIMARY KEY,
user_id BIGINT NOT NULL,
token_hash TEXT UNIQUE NOT NULL,
expires_at TIMESTAMPTZ NOT NULL,
used BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);

await db(`
CREATE TABLE IF NOT EXISTS transaction_pin_reset_tokens(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
code_hash TEXT NOT NULL,
expires_at TIMESTAMPTZ NOT NULL,
attempts INTEGER NOT NULL DEFAULT 0,
used BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS transaction_pin_reset_tokens_user_idx ON transaction_pin_reset_tokens(user_id)`);
await db(`CREATE INDEX IF NOT EXISTS transaction_pin_reset_tokens_expiry_idx ON transaction_pin_reset_tokens(expires_at)`);

await db(
`UPDATE users
SET user_id=COALESCE(
NULLIF(user_id,''),
gen_random_uuid()::text
)
WHERE user_id IS NULL
OR user_id=''`
);

await db(
`UPDATE users
SET updated_at=COALESCE(
updated_at,
created_at,
NOW()
)
WHERE updated_at IS NULL`
);

await db(
`CREATE UNIQUE INDEX IF NOT EXISTS
users_email_lower_idx
ON users(LOWER(email))`
);

await db(
`ALTER TABLE users
ALTER COLUMN user_id SET NOT NULL`
);

await db(
`ALTER TABLE users
ALTER COLUMN phone SET NOT NULL`
);

await db(
`CREATE UNIQUE INDEX IF NOT EXISTS
users_user_id_idx
ON users(user_id)`
);

await db(
`CREATE INDEX IF NOT EXISTS
password_reset_tokens_user_idx
ON password_reset_tokens(user_id)`
);

await db(
`CREATE INDEX IF NOT EXISTS
password_reset_tokens_expiry_idx
ON password_reset_tokens(expires_at)`
);

await db(`CREATE TABLE IF NOT EXISTS financial_ledger( id BIGSERIAL PRIMARY KEY, account_type TEXT NOT NULL, owner_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('credit','debit','opening')), amount NUMERIC(14,2) NOT NULL, balance_after NUMERIC(14,2) NOT NULL, reference TEXT UNIQUE NOT NULL, transaction_id BIGINT, category TEXT NOT NULL, description TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS financial_ledger_account_idx ON financial_ledger(account_type,owner_id,created_at DESC)`);
await db(`CREATE INDEX IF NOT EXISTS financial_ledger_transaction_idx ON financial_ledger(transaction_id)`);
await db(`CREATE INDEX IF NOT EXISTS financial_ledger_category_idx ON financial_ledger(category,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS platform_alerts( id BIGSERIAL PRIMARY KEY, alert_key TEXT UNIQUE NOT NULL, severity TEXT NOT NULL DEFAULT 'warning', title TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', details JSONB NOT NULL DEFAULT '{}'::jsonb, first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ, email_sent_at TIMESTAMPTZ)`);
await db(`CREATE INDEX IF NOT EXISTS platform_alerts_status_idx ON platform_alerts(status,last_seen_at DESC)`);
await db(`ALTER TABLE platform_alerts ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ`);
await db(`INSERT INTO financial_ledger(account_type,owner_id,direction,amount,balance_after,reference,category,description) SELECT 'customer_wallet',w.user_id,'opening',w.balance,w.balance,'OPENING-CUSTOMER-'||w.user_id,'opening_balance','Opening balance at Phase 3 ledger activation' FROM wallets w WHERE NOT EXISTS(SELECT 1 FROM financial_ledger f WHERE f.account_type='customer_wallet' AND f.owner_id=w.user_id)`);
await db(`INSERT INTO financial_ledger(account_type,owner_id,direction,amount,balance_after,reference,category,description) SELECT 'admin_wallet',a.admin_id,'opening',a.balance,a.balance,'OPENING-ADMIN-'||a.admin_id,'opening_balance','Opening admin operating wallet balance' FROM admin_wallets a WHERE NOT EXISTS(SELECT 1 FROM financial_ledger f WHERE f.account_type='admin_wallet' AND f.owner_id=a.admin_id::text)`);
await db(`INSERT INTO financial_ledger(account_type,owner_id,direction,amount,balance_after,reference,category,description) SELECT 'revenue_wallet',a.admin_id,'opening',a.balance,a.balance,'OPENING-REVENUE-'||a.admin_id,'opening_balance','Opening BOLTIV revenue wallet balance' FROM admin_revenue_wallets a WHERE NOT EXISTS(SELECT 1 FROM financial_ledger f WHERE f.account_type='revenue_wallet' AND f.owner_id=a.admin_id::text)`);

console.log(
"DATABASE SETUP COMPLETE"
);

}

async function createWallet(userId){

await db(
`INSERT INTO wallets(
user_id,
balance
)
VALUES($1,0)
ON CONFLICT(user_id)
DO NOTHING`,
[userId]
);

}

async function getWallet(userId){

const result=
await db(
`SELECT
user_id,
balance,
created_at,
updated_at
FROM wallets
WHERE user_id=$1`,
[userId]
);

if(!result.rows.length){
return null;
}

return{
...result.rows[0],
balance:Number(
result.rows[0].balance
)
};

}

async function addNotification(userId,title,message,type="info"){
  const uid=clean(userId),t=clean(title),m=clean(message),k=clean(type)||"info";
  if(!uid||!t||!m)return false;
  await db(`INSERT INTO notifications(user_id,title,message,type) VALUES($1,$2,$3,$4)`,[uid,t,m,k]);
  return true;
}
async function addNotificationOnce(userId,title,message,type="info",dedupeKey=""){
  const uid=clean(userId),t=clean(title),m=clean(message),k=clean(type)||"info";
  if(!uid||!t||!m)return false;
  if(dedupeKey){
  // The dedupe index is partial (dedupe_key IS NOT NULL), so PostgreSQL cannot
  // infer it from ON CONFLICT(dedupe_key) alone. Use an un-targeted conflict
  // clause so this remains safe across existing production schemas.
  const r=await db(`INSERT INTO notifications(user_id,title,message,type,dedupe_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,[uid,t,m,k,clean(dedupeKey)]);
  return Boolean(r.rows.length);
}
  return addNotification(uid,t,m,k);
}
async function adminNotifications(req){
  const admin=await adminFromToken(req); if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const b=await body(req),recipient=clean(b.recipient||"all").toLowerCase(),title=clean(b.title),message=clean(b.message),type=clean(b.type||"general");
  if(title.length<2||message.length<2)return{success:false,statusCode:400,message:"Notification title and message are required."};
  let userIds=[];
  if(recipient==="selected"){
    const id=clean(b.userId||b.user_id); if(!id)return{success:false,statusCode:400,message:"Select a user."};
    const u=await db(`SELECT user_id FROM users WHERE user_id=$1 LIMIT 1`,[id]); if(!u.rows.length)return{success:false,statusCode:404,message:"User not found."}; userIds=[u.rows[0].user_id];
  }else{userIds=(await db(`SELECT user_id FROM users WHERE status='active' ORDER BY created_at ASC`)).rows.map(x=>x.user_id);}
  if(!userIds.length)return{success:false,statusCode:400,message:"No eligible users found."};
  const client=await pool.connect(); try{await client.query("BEGIN");for(const uid of userIds)await client.query(`INSERT INTO notifications(user_id,title,message,type) VALUES($1,$2,$3,$4)`,[uid,title,message,type]);await client.query("COMMIT");try{await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,'notification_send','user','broadcast',$2::jsonb,$3)`,[admin.id,JSON.stringify({recipient,count:userIds.length,title,type}),requestIp(req)]);}catch{}return{success:true,sent:userIds.length,message:`Notification sent to ${userIds.length} user(s).`};}catch(e){try{await client.query("ROLLBACK")}catch{}throw e;}finally{client.release();}
}

async function getWalletSummary(userId){

const result=
await db(
`SELECT
COALESCE(SUM(amount) FILTER (WHERE type='credit' AND status='successful'),0) AS total_deposited,
COALESCE(SUM(amount) FILTER (WHERE type='debit' AND status='successful'),0) AS total_spent,
COALESCE(SUM(amount) FILTER (WHERE type='debit' AND status IN ('pending','processing')),0) AS pending_amount,
COALESCE(SUM(amount) FILTER (WHERE type='debit' AND status='successful' AND date>=NOW()-INTERVAL '7 days'),0) AS spent_week,
COALESCE(SUM(amount) FILTER (WHERE type='debit' AND status='successful' AND date>=date_trunc('month',NOW())),0) AS spent_month,
COALESCE(SUM(amount) FILTER (WHERE type='credit' AND status='successful' AND date>=NOW()-INTERVAL '7 days'),0) AS deposited_week,
COALESCE(SUM(amount) FILTER (WHERE type='credit' AND status='successful' AND date>=date_trunc('month',NOW())),0) AS deposited_month,
COALESCE(SUM(amount) FILTER (WHERE type='debit' AND status='successful' AND date>=date_trunc('month',NOW()) AND service ILIKE '%airtime%'),0) AS spent_month_airtime,
COALESCE(SUM(amount) FILTER (WHERE type='debit' AND status='successful' AND date>=date_trunc('month',NOW()) AND service ILIKE '%data%'),0) AS spent_month_data
FROM transactions
WHERE user_id=$1`,
[userId]
);

const row=result.rows[0]||{};

const spentMonth=Number(row.spent_month||0);
const spentMonthAirtime=Number(row.spent_month_airtime||0);
const spentMonthData=Number(row.spent_month_data||0);

return{
totalDeposited:Number(row.total_deposited||0),
totalSpent:Number(row.total_spent||0),
pendingAmount:Number(row.pending_amount||0),
spentThisWeek:Number(row.spent_week||0),
spentThisMonth:spentMonth,
depositedThisWeek:Number(row.deposited_week||0),
depositedThisMonth:Number(row.deposited_month||0),
spentThisMonthAirtime:spentMonthAirtime,
spentThisMonthData:spentMonthData,
spentThisMonthOther:Math.max(0,spentMonth-spentMonthAirtime-spentMonthData)
};

}

async function getTransactions(userId){

const result=
await db(
`SELECT id,user_id,type,service,amount,reference,status,date,idempotency_key,provider_reference,recipient,metadata
FROM transactions
WHERE user_id=$1
ORDER BY date DESC
LIMIT 100`,
[userId]
);

const rows=result.rows;
for(const item of rows){
  const service=String(item.service||"").toLowerCase();
  if(!service.includes("data"))continue;
  let meta=item.metadata;
  if(typeof meta==="string"){try{meta=JSON.parse(meta)}catch{meta={}}}
  meta=meta&&typeof meta==="object"?meta:{};
  const requestMeta=meta.request&&typeof meta.request==="object"?meta.request:{};
  const pricing=meta.pricing&&typeof meta.pricing==="object"?meta.pricing:{};
  const existing=clean(meta.plan||meta.plan_name||pricing.plan||requestMeta.plan_name||requestMeta.plan||"");
  if(existing && !/^Plan \d+$/i.test(existing))continue;
  const network=clean(meta.network||meta.network_provider||pricing.network||pricing.network_name||requestMeta.network||requestMeta.network_provider||"");
  const bundleId=requestMeta.bundle_id||meta.bundle_id||pricing.bundle_id||item.bundle_id;
  const resolved=await resolveDataPlanName(network,bundleId);
  if(resolved){
    item.metadata={...meta,plan:resolved,plan_name:resolved};
  }
}
return rows.map(item=>{
  let meta=item.metadata;
  if(typeof meta==="string"){try{meta=JSON.parse(meta)}catch{meta={}}}
  meta=meta&&typeof meta==="object"?meta:{};
  const requestMeta=meta.request&&typeof meta.request==="object"?meta.request:{};
  const pricing=meta.pricing&&typeof meta.pricing==="object"?meta.pricing:{};
  const network=clean(meta.network||meta.network_provider||pricing.network||pricing.network_name||requestMeta.network||requestMeta.network_provider||item.network||"");
  const plan=clean(meta.plan||meta.plan_name||pricing.plan||pricing.plan_name||requestMeta.plan_name||requestMeta.plan||item.plan||"");
  const phone=clean(item.recipient||meta.phone||requestMeta.phone||requestMeta.phone_number||item.phone||"");
  return {...item,amount:Number(item.amount),phone,network,plan};
});

}

function getUserSessionToken(req){
  const cookieHeader=String(req.headers.cookie||'');
  const match=cookieHeader.match(/(?:^|;\s*)boltiv_user_session=([^;]+)/);
  if(match){try{return decodeURIComponent(match[1]);}catch(_){return match[1];}}
  const authorization=req.headers.authorization||'';
  if(authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
  return null;
}
function setUserSessionCookie(res,token){
  const parts=[`boltiv_user_session=${encodeURIComponent(token)}`,'Path=/','HttpOnly','SameSite=None','Max-Age=2592000'];
  if(process.env.NODE_ENV==='production' || FRONTEND_URL.startsWith('https://')) parts.push('Secure');
  res.setHeader('Set-Cookie',parts.join('; '));
}
function clearUserSessionCookie(res){
  const parts=['boltiv_user_session=','Path=/','HttpOnly','SameSite=None','Max-Age=0'];
  if(process.env.NODE_ENV==='production' || FRONTEND_URL.startsWith('https://')) parts.push('Secure');
  res.setHeader('Set-Cookie',parts.join('; '));
}

async function getPlatformSetting(key, fallback=null){
  const settingKey=clean(key);
  if(!settingKey)return fallback;
  try{
    const result=await db(`SELECT value FROM platform_settings WHERE key=$1 LIMIT 1`,[settingKey]);
    if(!result.rows.length)return fallback;
    const value=result.rows[0].value;
    return value===null||value===undefined?fallback:value;
  }catch(error){
    console.error("PLATFORM SETTING READ ERROR:",error.message);
    return fallback;
  }
}

async function getSecurity(userId){
  const id=clean(userId);
  if(!id)return null;
  const result=await db(`SELECT transaction_pin_hash,updated_at FROM user_security WHERE user_id=$1 LIMIT 1`,[id]);
  return result.rows[0]||null;
}

async function setTransactionPin(userId,pin,currentPin=""){
  const id=clean(userId);
  const nextPin=String(pin||"").trim();
  const oldPin=String(currentPin||"").trim();

  if(!id)return{success:false,statusCode:401,message:"Unauthorized."};
  if(!/^\d{4}$/.test(nextPin))return{success:false,statusCode:400,message:"Transaction PIN must contain exactly 4 digits."};

  const existing=await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`,[id]);
  const existingHash=existing.rows[0]?.transaction_pin_hash||"";
  if(existingHash){
    if(!/^\d{4}$/.test(oldPin)||!verifyPassword(oldPin,existingHash)){
      return{success:false,statusCode:400,message:"Current Transaction PIN is incorrect."};
    }
  }

  const hash=hashPassword(nextPin);
  await db(`INSERT INTO user_security(user_id,transaction_pin_hash,updated_at)
    VALUES($1,$2,NOW())
    ON CONFLICT(user_id) DO UPDATE SET transaction_pin_hash=EXCLUDED.transaction_pin_hash,updated_at=NOW()`,[id,hash]);

  return{success:true,message:existingHash?"Transaction PIN changed successfully.":"Transaction PIN created successfully."};
}

async function userFromToken(req){

const sessionToken=getUserSessionToken(req);

if(!sessionToken){
return null;
}

const result=
await db(
`SELECT
u.id,
u.user_id,
u.name,
u.phone,
u.email,
u.status
FROM user_sessions s
JOIN users u
ON u.id=s.user_id
WHERE s.token=$1
AND s.expires_at>NOW()
AND u.status='active' `,
[sessionToken]
);

return result.rows[0]||null;

}

async function registerUser(
email,
password,
name,
phone,
termsAccepted
){

email=
clean(email).toLowerCase();

password=
String(password||"");

name=
clean(name);

phone=
clean(phone);

termsAccepted=Boolean(termsAccepted);

if(!termsAccepted){
return{
success:false,
message:"You must agree to the Terms & Conditions and Privacy Policy before creating your account."
};
}

if(name.length<2){

return{
success:false,
message:
"Please enter your full name."
};

}

if(!validPhone(phone)){

return{
success:false,
message:
"Please enter a valid Nigerian phone number."
};

}

if(!validEmail(email)){

return{
success:false,
message:
"Please enter a valid email address."
};

}

if(password.length<6){

return{
success:false,
message:
"Password must contain at least 6 characters."
};

}

const existing=
await db(
`SELECT id
FROM users
WHERE LOWER(email)=LOWER($1)`,
[email]
);

if(existing.rows.length){

return{
success:false,
message:
"An account with this email already exists."
};

}

const userId=
makeUserId();

const passwordHash=
hashPassword(password);

const result=
await db(
`INSERT INTO users(
user_id,
name,
phone,
email,
password_hash,
email_verified,
terms_accepted_at,
terms_version,
created_at,
updated_at
)
VALUES(
$1,$2,$3,$4,$5,FALSE,NOW(),'2026-08',NOW(),NOW()
)
RETURNING
id,
user_id,
name,
phone,
email`,
[
userId,
name,
phone,
email,
passwordHash
]
);

const user=
result.rows[0];

await createWallet(
user.user_id
);

let verificationEmailSent=true;
try{
  const verificationResult=await sendVerificationEmail(user);
  verificationEmailSent=Boolean(verificationResult.success);
  if(!verificationEmailSent)console.error("REGISTRATION VERIFICATION EMAIL FAILED:",verificationResult.message);
}catch(error){
  verificationEmailSent=false;
  console.error("REGISTRATION VERIFICATION EMAIL ERROR:",error?.stack||error?.message||error);
}

return{
success:true,
message:
verificationEmailSent
? "Account created successfully. Please check your email and verify your email address before signing in."
: "Account created successfully, but the verification email could not be sent. Please request another verification email before signing in.",
transactionPinSet:false,
verificationEmailSent,
user:{
id:user.user_id,
userId:user.user_id,
name:user.name,
phone:user.phone,
email:user.email
}
};

}

async function loginUser(
email,
password
){

email=
clean(email).toLowerCase();

password=
String(password||"");

const result=
await db(
`SELECT
id,
user_id,
name,
phone,
email,
password_hash,
status,
email_verified
FROM users
WHERE LOWER(email)=LOWER($1)`,
[email]
);

if(!result.rows.length){

return{
success:false,
message:
"Invalid email or password."
};

}

const user=
result.rows[0];

if(user.status==="suspended"){
return{success:false,message:"Your account is suspended. Please contact support."};
}

if(!verifyPassword(
password,
user.password_hash
)){

return{
success:false,
message:
"Invalid email or password."
};

}

if(user.email_verified !== true){
return{
success:false,
code:"EMAIL_NOT_VERIFIED",
message:"Please verify your email address before signing in. Check your inbox for the BOLTIV verification email."
};
}

if(!user.user_id){

user.user_id=
makeUserId();

await db(
`UPDATE users
SET user_id=$1
WHERE id=$2`,
[
user.user_id,
user.id
]
);

}

await createWallet(
user.user_id
);

const sessionToken=
token();

await db(
`INSERT INTO user_sessions(
token,
user_id,
expires_at
)
VALUES(
$1,
$2,
NOW()+INTERVAL '30 days'
)`,
[
sessionToken,
user.id
]
);

return{
success:true,
message:
"Login successful.",
_sessionToken:sessionToken,
user:{
id:user.user_id,
userId:user.user_id,
name:user.name||"",
phone:user.phone||"",
email:user.email
}
};

}

async function logoutUser(req,res){
  const sessionToken=getUserSessionToken(req);
  if(sessionToken){ await db(`DELETE FROM user_sessions WHERE token=$1`,[sessionToken]); }
  clearUserSessionCookie(res);
  return{success:true,message:"Logged out successfully."};
}

async function sendEmail({
to,
subject,
html
}){

if(!RESEND_API_KEY){

console.log(
"RESEND_API_KEY is not configured."
);

return{
success:false,
message:
"Email service is not configured."
};

}

try{

const response=
await fetch(
"https://api.resend.com/emails",
{
method:"POST",
headers:{
"Authorization":
`Bearer ${RESEND_API_KEY}`,
"Content-Type":
"application/json"
},
body:JSON.stringify({
from:MAIL_FROM,
to:[to],
subject,
html
})
}
);

const data=
await response.json();

if(!response.ok){

console.error(
"EMAIL ERROR:",
data
);

return{
success:false,
message:
"Unable to send email."
};

}

return{
success:true,
data
};

}catch(error){

console.error(
"EMAIL CONNECTION ERROR:",
error
);

return{
success:false,
message:
"Unable to send email."
};

}

}


function hashResetToken(value){

return crypto
.createHash("sha256")
.update(String(value))
.digest("hex");

}


async function requestPasswordReset(
email
){

email=
clean(email).toLowerCase();

if(!validEmail(email)){

return{
success:true,
message:
"If an account exists for that email, a password reset link has been sent."
};

}

/*
Always return the same public response
whether the account exists or not.
This prevents email/account enumeration.
*/

const genericMessage=
"If an account exists for that email, a password reset link has been sent.";

const result=
await db(
`SELECT
id,
name,
email
FROM users
WHERE LOWER(email)=LOWER($1)
LIMIT 1`,
[email]
);

if(!result.rows.length){

return{
success:true,
message:
genericMessage
};

}

const user=
result.rows[0];

/*
Invalidate previous unused reset tokens
for this user.
*/

await db(
`UPDATE password_reset_tokens
SET used=TRUE
WHERE user_id=$1
AND used=FALSE`,
[user.id]
);

const rawToken=
crypto.randomBytes(32).toString("hex");

const tokenHash=
hashResetToken(rawToken);

await db(
`INSERT INTO password_reset_tokens(
user_id,
token_hash,
expires_at,
used,
created_at
)
VALUES(
$1,
$2,
NOW()+INTERVAL '30 minutes',
FALSE,
NOW()
)`,
[
user.id,
tokenHash
]
);

const resetUrl=
`${FRONTEND_URL}/reset-password?token=${encodeURIComponent(rawToken)}`;

const displayName=
clean(user.name)||
"BOLTIV User";

const emailResult=
await sendEmail({

to:user.email,

subject:
"BOLTIV Password Reset",

html:`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">
</head>

<body style="
margin:0;
padding:0;
background:#f6f6f6;
font-family:Arial,sans-serif;
color:#171717;
">

<div style="
max-width:520px;
margin:40px auto;
background:#ffffff;
border-radius:18px;
padding:32px;
border:1px solid #e7e7e7;
">

<div style="
font-size:28px;
font-weight:900;
letter-spacing:4px;
color:#c49a25;
text-align:center;
">
BOLTIV
</div>

<h2 style="
text-align:center;
margin-top:28px;
">
Reset your password
</h2>

<p style="
font-size:15px;
line-height:1.7;
color:#555;
">
Hello ${escapeHtmlEmail(displayName)},
</p>

<p style="
font-size:15px;
line-height:1.7;
color:#555;
">
We received a request to reset your BOLTIV password.
Click the button below to choose a new password.
</p>

<div style="
text-align:center;
margin:30px 0;
">

<a
href="${resetUrl}"
style="
display:inline-block;
padding:14px 24px;
background:#d4af37;
color:#111111;
text-decoration:none;
font-weight:900;
border-radius:10px;
"
>
RESET PASSWORD
</a>

</div>

<p style="
font-size:13px;
line-height:1.6;
color:#777;
">
This link expires in 30 minutes and can only be used once.
</p>

<p style="
font-size:13px;
line-height:1.6;
color:#777;
">
If you didn't request this password reset, you can safely ignore this email.
</p>

</div>

</body>
</html>
`

});

if(!emailResult.success){

/*
The reset token must never remain usable when the
email could not be sent. Remove the token we just
created so the user cannot end up with an unusable
reset request.
*/

console.error(
"PASSWORD RESET EMAIL FAILED:",
emailResult.message
);

try{

await db(
`DELETE FROM password_reset_tokens
 WHERE user_id=$1
 AND token_hash=$2`,
[user.id,tokenHash]
);

}catch(cleanupError){

console.error(
"PASSWORD RESET TOKEN CLEANUP FAILED:",
cleanupError
);

}

return{
success:false,
message:
"We couldn't send the password reset email right now. Please try again later."
};

}

return{
success:true,
message:
genericMessage
};

}


function escapeHtmlEmail(value){

return String(value??"")
.replace(/&/g,"&amp;")
.replace(/</g,"&lt;")
.replace(/>/g,"&gt;")
.replace(/"/g,"&quot;")
.replace(/'/g,"&#039;");

}


async function createEmailVerificationToken(userId){
  await db(`UPDATE email_verification_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE`,[userId]);
  const rawToken=crypto.randomBytes(32).toString("hex");
  const tokenHash=hashResetToken(rawToken);
  await db(`INSERT INTO email_verification_tokens(user_id,token_hash,expires_at,used,created_at)
    VALUES($1,$2,NOW()+INTERVAL '24 hours',FALSE,NOW())`,[userId,tokenHash]);
  return rawToken;
}

async function sendVerificationEmail(user){
  const rawToken=await createEmailVerificationToken(user.id);
  const verifyUrl=`${FRONTEND_URL}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const displayName=clean(user.name)||"BOLTIV User";
  const result=await sendEmail({
    to:user.email,
    subject:"Verify your BOLTIV email",
    html:`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#171717">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:18px;padding:32px;border:1px solid #e7e7e7">
<div style="font-size:28px;font-weight:900;letter-spacing:4px;color:#c49a25;text-align:center">BOLTIV</div>
<h2 style="text-align:center;margin-top:28px">Verify your email</h2>
<p style="font-size:15px;line-height:1.7;color:#555">Hello ${escapeHtmlEmail(displayName)},</p>
<p style="font-size:15px;line-height:1.7;color:#555">Please verify your email address to keep your BOLTIV account secure.</p>
<p style="text-align:center;margin:30px 0"><a href="${verifyUrl}" style="display:inline-block;background:#c49a25;color:#fff;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:700">VERIFY EMAIL</a></p>
<p style="font-size:13px;line-height:1.6;color:#777">This verification link expires in 24 hours.</p>
</div></body></html>`
  });
  if(!result.success){
    try{ await db(`DELETE FROM email_verification_tokens WHERE user_id=$1 AND token_hash=$2`,[user.id,hashResetToken(rawToken)]); }catch{}
  }
  return result;
}

async function verifyEmailToken(rawToken){
  rawToken=clean(rawToken);
  if(!rawToken)return{success:false,message:"Verification token is required."};
  const tokenHash=hashResetToken(rawToken);
  const r=await db(`SELECT id,user_id FROM email_verification_tokens WHERE token_hash=$1 AND used=FALSE AND expires_at>NOW() LIMIT 1`,[tokenHash]);
  if(!r.rows.length)return{success:false,message:"This verification link is invalid or has expired."};
  const token=r.rows[0];
  await db(`UPDATE users SET email_verified=TRUE,updated_at=NOW() WHERE id=$1`,[token.user_id]);
  await db(`UPDATE email_verification_tokens SET used=TRUE WHERE id=$1`,[token.id]);
  return{success:true,message:"Your email has been verified successfully."};
}

async function sendTransactionEmail(userId, tx, status){
  try{
    const r=await db(`SELECT name,email FROM users WHERE user_id=$1 LIMIT 1`,[String(userId)]);
    const user=r.rows[0];
    if(!user?.email)return{success:false,message:"Customer email is unavailable."};
    const amount=Number(tx.amount||0).toLocaleString("en-NG",{minimumFractionDigits:2});
    const service=escapeHtmlEmail(String(tx.service||"BOLTIV service"));
    const recipient=tx.recipient?`<p style="font-size:14px;color:#666">Recipient: ${escapeHtmlEmail(tx.recipient)}</p>`:"";
    const title=status==="successful"?"Transaction successful":"Transaction refunded";
    const body=status==="successful"
      ?`Your ${service} purchase of ₦${amount} was successful.`
      :`Your ${service} transaction of ₦${amount} was refunded to your BOLTIV wallet.`;
    return await sendEmail({
      to:user.email,
      subject:`BOLTIV ${title}`,
      html:`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#171717">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:18px;padding:32px;border:1px solid #e7e7e7">
<div style="font-size:28px;font-weight:900;letter-spacing:4px;color:#c49a25;text-align:center">BOLTIV</div>
<h2 style="text-align:center;margin-top:28px">${title}</h2>
<p style="font-size:15px;line-height:1.7;color:#555">Hello ${escapeHtmlEmail(user.name||"BOLTIV User")},</p>
<p style="font-size:15px;line-height:1.7;color:#555">${body}</p>
${recipient}
<p style="font-size:13px;line-height:1.6;color:#777">Reference: ${escapeHtmlEmail(tx.reference||"N/A")}</p>
</div></body></html>`
    });
  }catch(error){
    console.error("TRANSACTION EMAIL ERROR:",error?.stack||error?.message||error);
    return{success:false,message:"Unable to send transaction email."};
  }
}

async function sendWalletFundingEmail(userId, amount, reference){
  try{
    const r=await db(`SELECT name,email FROM users WHERE user_id=$1 LIMIT 1`,[String(userId)]);
    const user=r.rows[0];
    if(!user?.email)return{success:false,message:"Customer email is unavailable."};
    const formatted=Number(amount||0).toLocaleString("en-NG",{minimumFractionDigits:2});
    return await sendEmail({
      to:user.email,
      subject:"BOLTIV Wallet Funding Successful",
      html:`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#171717">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:18px;padding:32px;border:1px solid #e7e7e7">
<div style="font-size:28px;font-weight:900;letter-spacing:4px;color:#c49a25;text-align:center">BOLTIV</div>
<h2 style="text-align:center;margin-top:28px">Wallet funded</h2>
<p style="font-size:15px;line-height:1.7;color:#555">Hello ${escapeHtmlEmail(user.name||"BOLTIV User")}, your BOLTIV wallet was credited with <strong>₦${formatted}</strong> via Flutterwave.</p>
<p style="font-size:13px;line-height:1.6;color:#777">Reference: ${escapeHtmlEmail(reference||"N/A")}</p>
</div></body></html>`
    });
  }catch(error){
    console.error("WALLET FUNDING EMAIL ERROR:",error?.stack||error?.message||error);
    return{success:false,message:"Unable to send wallet funding email."};
  }
}


async function resetPassword(
rawToken,
newPassword
){

rawToken=
clean(rawToken);

newPassword=
String(newPassword||"");

if(!rawToken){

return{
success:false,
message:
"Password reset token is required."
};

}

if(newPassword.length<6){

return{
success:false,
message:
"Password must contain at least 6 characters."
};

}

const tokenHash=
hashResetToken(rawToken);

const result=
await db(
`SELECT
id,
user_id,
expires_at,
used
FROM password_reset_tokens
WHERE token_hash=$1
AND used=FALSE
AND expires_at>NOW()
LIMIT 1`,
[tokenHash]
);

if(!result.rows.length){

return{
success:false,
message:
"This password reset link is invalid or has expired."
};

}

const reset=
result.rows[0];

const passwordHash=
hashPassword(newPassword);

const client=
await pool.connect();

try{

await client.query("BEGIN");

/*
Update the password.
*/

await client.query(
`UPDATE users
SET password_hash=$1,
updated_at=NOW()
WHERE id=$2`,
[
passwordHash,
reset.user_id
]
);

/*
Mark the token as used.
*/

await client.query(
`UPDATE password_reset_tokens
SET used=TRUE
WHERE id=$1`,
[
reset.id
]
);

/*
Invalidate all existing sessions.
This forces the user to log in again
with the new password.
*/

await client.query(
`DELETE FROM user_sessions
WHERE user_id=$1`,
[
reset.user_id
]
);

await client.query("COMMIT");

return{
success:true,
message:
"Password reset successful. Please log in with your new password."
};

}catch(error){

await client.query("ROLLBACK");

console.error(
"PASSWORD RESET ERROR:",
error
);

return{
success:false,
message:
"Unable to reset password."
};

}finally{

client.release();

}

}


async function cleanupTransactionPinResetTokens(){
  if(!DATABASE_URL)return;
  try{await db(`DELETE FROM transaction_pin_reset_tokens WHERE expires_at<NOW() OR used=TRUE`);}catch(error){console.error("TRANSACTION PIN RESET TOKEN CLEANUP ERROR:",error?.message||error);}
}

async function cleanupPasswordResetTokens(){

if(!DATABASE_URL){
return;
}

try{

await db(
`DELETE FROM password_reset_tokens
WHERE expires_at<NOW()
OR used=TRUE`
);

}catch(error){

console.error(
"RESET TOKEN CLEANUP ERROR:",
error.message
);

}

}



async function recordSecurityEvent(eventType,severity="info",details={},req=null,adminId=null){
try{
const safeDetails = details && typeof details === "object" ? details : {value:String(details??"")};
await db(
`INSERT INTO security_events(
admin_id,
event_type,
severity,
details,
ip
)
VALUES($1,$2,$3,$4::jsonb,$5)`,
[
adminId||null,
String(eventType||"security_event"),
String(severity||"info"),
JSON.stringify(safeDetails),
req ? requestIp(req) : null
]
);
}catch(err){
console.error("Failed to record security event:",err?.message||err);
}
}

async function adminLogin(
email,
password,
req=null
){

if(req){const rl=rateLimit(req,"admin-login",5,15*60*1000);if(!rl.allowed)return{success:false,statusCode:429,message:"Too many admin login attempts. Try again later."};}

email=
clean(email).toLowerCase();

password=
String(password||"");

if(!ADMIN_EMAIL||
!ADMIN_PASSWORD){

return{
success:false,
message:
"Admin environment variables are not configured."
};

}

let result=
await db(
`SELECT
id,
email,
password_hash
FROM admins
WHERE LOWER(email)=LOWER($1)`,
[ADMIN_EMAIL]
);

if(!result.rows.length){

const passwordHash=
hashPassword(ADMIN_PASSWORD);

result=
await db(
`INSERT INTO admins(
email,
password_hash
)
VALUES($1,$2)
RETURNING
id,
email,
password_hash`,
[
ADMIN_EMAIL,
passwordHash
]
);

}else{

/*
Keep the database admin synchronized
with Render environment variables.
*/

const admin=
result.rows[0];

if(
admin.email.toLowerCase()!==
ADMIN_EMAIL.toLowerCase()||
!verifyPassword(
ADMIN_PASSWORD,
admin.password_hash
)
){

const passwordHash=
hashPassword(ADMIN_PASSWORD);

result=
await db(
`UPDATE admins
SET
email=$1,
password_hash=$2
WHERE id=$3
RETURNING
id,
email,
password_hash`,
[
ADMIN_EMAIL,
passwordHash,
admin.id
]
);

}

}

const admin=
result.rows[0];

if(!admin){

return{
success:false,
message:
"Unable to initialize admin account."
};

}

if(
email!==ADMIN_EMAIL.toLowerCase()
||
!verifyPassword(
password,
admin.password_hash
)
){

await recordSecurityEvent('admin_login_failed','warning',{email},req,null);

return{
success:false,
message:
"Invalid admin credentials."
};

}

await db(
`DELETE FROM admin_sessions
WHERE expires_at<NOW()`
);

const sessionToken=
token();
const csrfToken=token();

await recordSecurityEvent('admin_login_success','info',{email:admin.email},req,admin.id);

await db(
`INSERT INTO admin_sessions(
token,
admin_id,
expires_at,
csrf_token
)
VALUES(
$1,
$2,
NOW()+INTERVAL '24 hours',
$3
)`,
[
sessionToken,
admin.id,
csrfToken
]
);

return{
success:true,
message:
"Admin login successful.",
token:
sessionToken,
admin:{
id:admin.id,
email:admin.email
}
};

}



function getAdminSessionToken(req){
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)boltiv_admin_session=([^;]+)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
  }
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function setAdminSessionCookie(res, token){
  const parts = [
    `boltiv_admin_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=None",
    "Secure",
    "Max-Age=86400"
  ];
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminSessionCookie(res){
  const parts = [
    "boltiv_admin_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=None",
    "Secure",
    "Max-Age=0"
  ];
  res.setHeader("Set-Cookie", parts.join("; "));
}

async function adminFromToken(req){

const sessionToken=getAdminSessionToken(req);
if(!sessionToken)return null;

const result=await db(
`SELECT a.id,a.email
 FROM admin_sessions s
 JOIN admins a ON a.id=s.admin_id
 WHERE s.token=$1 AND s.expires_at>NOW()`,
[sessionToken]
);

return result.rows[0]||null;

}

async function logoutAdmin(req){

const sessionToken=getAdminSessionToken(req);
if(sessionToken){
await db(`DELETE FROM admin_sessions WHERE token=$1`,[sessionToken]);
}

return{
success:true,
message:"Admin logged out successfully."
};

}


/* ===================== PHASE 3 FINANCIAL LEDGER ===================== */
async function addFinancialLedger(client,{accountType,ownerId,direction,amount,balanceAfter,reference,transactionId=null,category,description,metadata={}}){
  await client.query(`INSERT INTO financial_ledger(account_type,owner_id,direction,amount,balance_after,reference,transaction_id,category,description,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(reference) DO NOTHING`,[String(accountType),String(ownerId),String(direction),Number(amount),Number(balanceAfter),String(reference),transactionId||null,String(category),String(description),JSON.stringify(metadata||{})]);
}

/* ===================== ADMIN WALLET / REVENUE HELPERS ===================== */
async function ensureAdminWallet(client,adminId){
  await client.query(`INSERT INTO admin_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[adminId]);
}
async function addAdminLedger(client,adminId,type,amount,balanceAfter,description,ref){
  await client.query(`INSERT INTO admin_wallet_ledger(admin_id,type,amount,balance_after,reference,description) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(reference) DO NOTHING`,[adminId,type,Number(amount),Number(balanceAfter),String(ref),String(description)]);
  await addFinancialLedger(client,{accountType:"admin_wallet",ownerId:String(adminId),direction:Number(amount)>=0?"credit":"debit",amount:Number(amount),balanceAfter:Number(balanceAfter),reference:`FIN-${ref}`,category:type,description,metadata:{source:"admin_wallet"}});
}
async function getAdminWallet(adminId){
  await db(`INSERT INTO admin_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[adminId]);
  const row=(await db(`SELECT balance,created_at,updated_at FROM admin_wallets WHERE admin_id=$1`,[adminId])).rows[0]||{};
  return {balance:Number(row.balance||0),created_at:row.created_at||null,updated_at:row.updated_at||null};
}
async function ensureAdminRevenueWallet(client,adminId){
  await client.query(`INSERT INTO admin_revenue_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[adminId]);
}
async function addAdminRevenueLedger(client,adminId,type,amount,balanceAfter,description,ref){
  await client.query(`INSERT INTO admin_revenue_ledger(admin_id,type,amount,balance_after,reference,description) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(reference) DO NOTHING`,[adminId,type,Number(amount),Number(balanceAfter),String(ref),String(description)]);
  await addFinancialLedger(client,{accountType:"revenue_wallet",ownerId:String(adminId),direction:Number(amount)>=0?"credit":"debit",amount:Number(amount),balanceAfter:Number(balanceAfter),reference:`FIN-${ref}`,category:type,description,metadata:{source:"revenue_wallet"}});
}

async function getPrimaryAdminId(client){
  const r=await client.query(`SELECT id FROM admins WHERE LOWER(email)=LOWER($1) LIMIT 1`,[ADMIN_EMAIL]);
  if(r.rows[0]?.id)return Number(r.rows[0].id);
  const fallback=await client.query(`SELECT id FROM admins ORDER BY id ASC LIMIT 1`);
  return fallback.rows[0]?.id?Number(fallback.rows[0].id):null;
}

async function recordRevenueSale(client,tx){
  const adminId=await getPrimaryAdminId(client);
  if(!adminId)return false;
  await ensureAdminRevenueWallet(client,adminId);
  const saleRef=`SALE-${tx.reference}`;
  const existing=await client.query(`SELECT id FROM admin_revenue_ledger WHERE reference=$1 LIMIT 1`,[saleRef]);
  if(existing.rows.length)return true;
  const w=await client.query(`UPDATE admin_revenue_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[Number(tx.amount),adminId]);
  if(!w.rows.length)throw new Error("Revenue wallet could not be credited.");
  await addAdminRevenueLedger(client,adminId,"sale",Number(tx.amount),Number(w.rows[0].balance),`Customer ${tx.service} sale`,saleRef);
  return true;
}

async function recordRevenueRefund(client,tx){
  const adminId=await getPrimaryAdminId(client);
  if(!adminId)return false;
  const saleRef=`SALE-${tx.reference}`;
  const sale=await client.query(`SELECT id FROM admin_revenue_ledger WHERE reference=$1 LIMIT 1`,[saleRef]);
  if(!sale.rows.length)return false;
  const refundRef=`REFUND-${tx.reference}`;
  const existing=await client.query(`SELECT id FROM admin_revenue_ledger WHERE reference=$1 LIMIT 1`,[refundRef]);
  if(existing.rows.length)return true;
  await ensureAdminRevenueWallet(client,adminId);
  const w=await client.query(`UPDATE admin_revenue_wallets SET balance=balance-$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[Number(tx.amount),adminId]);
  if(!w.rows.length)throw new Error("Revenue wallet could not be debited for refund.");
  await addAdminRevenueLedger(client,adminId,"refund",-Number(tx.amount),Number(w.rows[0].balance),`Refunded customer ${tx.service} sale`,refundRef);
  return true;
}

/* ===================== FLUTTERWAVE VIRTUAL ACCOUNT FUNDING ===================== */

function flutterwaveConfigured(){
return Boolean(FLW_SECRET_KEY);
}

function normalizeNgPhone(phone){
let p=String(phone||"").replace(/\D/g,"");
if(p.startsWith("234")&&p.length===13)p="0"+p.slice(3);
if(p.length===10&&/^[789]/.test(p))p="0"+p;
return p;
}
function splitName(name,email){const value=clean(name)||clean(email).split("@")[0]||"BOLTIV User";const parts=value.split(/\s+/).filter(Boolean);return{first:parts.shift()||"BOLTIV",last:parts.join(" ")||"User"};}
function flutterwaveError(r,fallback="Flutterwave request failed."){const message=r?.data?.message||r?.data?.error||r?.message;return typeof message==="string"&&message.trim()?message.trim():fallback;}
async function flutterwaveRequest(path,options={}){
if(!flutterwaveConfigured())return{success:false,statusCode:503,message:"Flutterwave is not configured."};
try{const response=await fetch(`${FLW_BASE_URL}${path}`,{...options,headers:{Authorization:`Bearer ${FLW_SECRET_KEY}`,"Content-Type":"application/json",Accept:"application/json",...(options.headers||{})}});let data={};try{data=await response.json();}catch{}return{success:Boolean(response.ok&&data?.status!=="error"),statusCode:response.status,data};}catch(error){console.error("FLUTTERWAVE REQUEST ERROR:",error.message);return{success:false,statusCode:502,message:"Unable to connect to Flutterwave."};}
}
function parseDateOrNull(value){if(!value||String(value).toUpperCase()==="N/A")return null;const d=new Date(value);return Number.isNaN(d.getTime())?null:d;}
function extractFlutterwaveVA(data){const d=data?.data||data?.result||data||{};return{accountNumber:clean(d.account_number||d.accountNumber||d.transfer_account||d.account?.account_number),accountName:clean(d.account_name||d.accountName||d.full_name||d.name),bankName:clean(d.bank_name||d.bankName||d.transfer_bank||d.bank?.name),bankCode:clean(d.bank_code||d.bankCode||d.transfer_bank_code||d.bank?.code),providerAccountId:clean(d.id||d.account_id||d.virtual_account_id),providerCustomerId:clean(d.customer_id||d.customerId),txRef:clean(d.tx_ref||d.txRef),expiryDate:parseDateOrNull(d.expiry_date||d.expiryDate),raw:d};}
async function getFlutterwaveStaticFundingAccount(user){const r=await db(`SELECT * FROM flutterwave_virtual_accounts WHERE owner_type='user' AND owner_id=$1 AND account_type='static' AND status='active' LIMIT 1`,[user.user_id]);return{success:true,account:r.rows[0]||null};}
async function createFlutterwaveVirtualAccount({ownerType="user",ownerId,user,accountType="static",amount=0,identityType="",identityNumber=""}){
if(!flutterwaveConfigured())throw new Error("Flutterwave is not configured. Set FLW_SECRET_KEY on the server.");
if(!ownerId)throw new Error("Account owner is required.");
if(!["static","dynamic"].includes(accountType))throw new Error("Invalid virtual account type.");
if(accountType==="dynamic"&&(!Number.isFinite(Number(amount))||Number(amount)<=0))throw new Error("A valid deposit amount is required for a dynamic account.");
if(accountType==="static"){
const existing=await db(`SELECT * FROM flutterwave_virtual_accounts WHERE owner_type=$1 AND owner_id=$2 AND account_type='static' AND status='active' LIMIT 1`,[ownerType,ownerId]);if(existing.rows.length)return{success:true,account:existing.rows[0],existing:true};
if(!["nin","bvn"].includes(String(identityType).toLowerCase()))throw new Error("Choose NIN or BVN for a permanent account.");
if(!/^\d{11}$/.test(String(identityNumber||"")))throw new Error("Enter a valid 11-digit NIN or BVN.");
}
const name=splitName(user?.name,user?.email),email=clean(user?.email),phone=normalizeNgPhone(user?.phone);if(!email)throw new Error("A valid email address is required.");if(!phone||phone.length<11)throw new Error("A valid Nigerian phone number is required on your profile.");
const ref=reference(`BOLTIV-${accountType.toUpperCase()}`).replace(/[^a-zA-Z0-9-]/g,"-").slice(0,42);
const payload={email,amount:accountType==="static"?0:Number(amount),currency:"NGN",firstname:name.first,lastname:name.last,tx_ref:ref,is_permanent:accountType==="static",narration:`BOLTIV ${accountType} funding`,phonenumber:phone};
if(accountType==="static")payload[String(identityType).toLowerCase()]=String(identityNumber);
const r=await flutterwaveRequest("/virtual-account-numbers",{method:"POST",body:JSON.stringify(payload)});if(!r.success)throw new Error(flutterwaveError(r,"Unable to create Flutterwave virtual account."));
const account=extractFlutterwaveVA(r.data);if(!account.accountNumber)throw new Error("Flutterwave did not return a virtual account number.");
const result=await db(`INSERT INTO flutterwave_virtual_accounts(owner_type,owner_id,account_type,account_number,account_name,bank_name,bank_code,currency,amount,status,provider_account_id,provider_customer_id,tx_ref,identity_type,expiry_date,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,'NGN',$8,'active',$9,$10,$11,$12,$13,$14) ON CONFLICT(account_number) DO UPDATE SET account_name=EXCLUDED.account_name,bank_name=EXCLUDED.bank_name,bank_code=EXCLUDED.bank_code,amount=EXCLUDED.amount,status='active',provider_account_id=EXCLUDED.provider_account_id,provider_customer_id=EXCLUDED.provider_customer_id,expiry_date=EXCLUDED.expiry_date,metadata=EXCLUDED.metadata,updated_at=NOW() RETURNING *`,[ownerType,ownerId,accountType,account.accountNumber,account.accountName||`${name.first} ${name.last}`,account.bankName,account.bankCode||null,Number(accountType==="static"?0:amount),account.providerAccountId||null,account.providerCustomerId||null,ref,accountType==="static"?String(identityType).toLowerCase():null,account.expiryDate,JSON.stringify(account.raw||{})]);
return{success:true,account:result.rows[0],existing:false};
}
async function createCustomerFlutterwaveStaticAccount(user,identityType,identityNumber){return createFlutterwaveVirtualAccount({ownerType:"user",ownerId:user.user_id,user,accountType:"static",identityType,identityNumber});}
async function createCustomerFlutterwaveDynamicAccount(user,amount){return createFlutterwaveVirtualAccount({ownerType:"user",ownerId:user.user_id,user,accountType:"dynamic",amount});}
async function creditFlutterwaveVirtualAccount(payload){
const data=payload?.data||payload||{};const accountNumber=clean(data?.account?.account_number||data?.account_number||data?.transfer_account||payload?.meta_data?.account_number||payload?.meta?.account_number);const amount=Number(data?.amount||data?.amount_settled||data?.charged_amount||0);const txId=clean(data?.id||data?.flw_ref||data?.tx_ref||payload?.id);const txRef=clean(data?.tx_ref||data?.reference||"");if(!Number.isFinite(amount)||amount<=0)throw new Error("Flutterwave webhook has an invalid amount.");if(!txId&&!txRef&&!accountNumber)throw new Error("Flutterwave webhook is missing a transaction identifier.");let va=null;if(txRef)va=(await db(`SELECT * FROM flutterwave_virtual_accounts WHERE tx_ref=$1 LIMIT 1`,[txRef])).rows[0]||null;if(!va&&accountNumber)va=(await db(`SELECT * FROM flutterwave_virtual_accounts WHERE account_number=$1 LIMIT 1`,[accountNumber])).rows[0]||null;if(!va)throw new Error("No BOLTIV owner is mapped to this Flutterwave virtual-account payment.");
if(txId || txRef){
const verified=/^\d+$/.test(txId)?await flutterwaveRequest(`/transactions/${encodeURIComponent(txId)}/verify`):await flutterwaveRequest(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
const vd=verified.data?.data||{};
if(!verified.success||String(vd.status||"").toLowerCase()!=="successful")throw new Error(flutterwaveError(verified,"Flutterwave transaction verification failed."));
if(String(vd.currency||"").toUpperCase()!=="NGN")throw new Error("Flutterwave transaction currency is not NGN.");
if(Number(vd.amount||0)<=0)throw new Error("Flutterwave transaction amount is invalid.");
}
const client=await pool.connect();try{await client.query("BEGIN");const eventId=txId||txRef||accountNumber;const existing=await client.query(`SELECT processed FROM flutterwave_webhook_events WHERE event_id=$1 FOR UPDATE`,[eventId]);if(existing.rows.length&&existing.rows[0].processed){await client.query("COMMIT");return{success:true,duplicate:true};}await client.query(`INSERT INTO flutterwave_webhook_events(event_id,event_type,payload,processed) VALUES($1,$2,$3,FALSE) ON CONFLICT(event_id) DO NOTHING`,[eventId,String(payload?.event||payload?.type||"charge.completed"),JSON.stringify(payload)]);
if(va.owner_type==="admin"){const adminId=Number(va.owner_id);await ensureAdminWallet(client,adminId);const wr=await client.query(`UPDATE admin_wallets SET balance=balance+$1,updated_at=NOW() WHERE admin_id=$2 RETURNING balance`,[amount,adminId]);if(!wr.rows.length)throw new Error("Admin wallet could not be credited.");await addAdminLedger(client,adminId,"funding",amount,Number(wr.rows[0].balance),"Flutterwave virtual-account funding",`FLW-ADMIN-${eventId}`);await client.query(`UPDATE flutterwave_webhook_events SET processed=TRUE,processed_at=NOW() WHERE event_id=$1`,[eventId]);await client.query("COMMIT");return{success:true,duplicate:false,amount,ownerType:"admin",adminId};}
const userId=String(va.owner_id);await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[userId]);const wr=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[amount,userId]);if(!wr.rows.length)throw new Error("Wallet could not be credited.");const referenceValue=`FUND-${eventId}`;const tr=await client.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,date,provider_reference,metadata) VALUES($1,'credit','Wallet Funding',$2,$3,'successful',NOW(),$4,$5) ON CONFLICT(reference) DO NOTHING RETURNING id`,[userId,amount,referenceValue,txRef||txId,JSON.stringify({provider:"flutterwave",account_number:accountNumber||va.account_number,account_type:va.account_type,payload})]);if(tr.rows.length){await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:userId,direction:"credit",amount:Number(amount),balanceAfter:Number(wr.rows[0].balance),reference:`WALLET-FUND-${eventId}`,transactionId:tr.rows[0].id,category:"wallet_funding",description:"Flutterwave wallet funding",metadata:{provider_reference:txRef||txId}});}else{console.error("FUNDING LEDGER SKIPPED: transaction reference already existed",referenceValue);}await client.query(`UPDATE flutterwave_webhook_events SET processed=TRUE,processed_at=NOW() WHERE event_id=$1`,[eventId]);await client.query("COMMIT");try{await addNotification(userId,"Wallet credited",`Your wallet was credited with ₦${amount.toLocaleString("en-NG",{minimumFractionDigits:2})} via Flutterwave bank transfer.` ,"payment");}catch{}
try{await sendWalletFundingEmail(userId,amount,txRef||txId||referenceValue);}catch(error){console.error("WALLET FUNDING EMAIL HOOK ERROR:",error?.stack||error?.message||error);}
return{success:true,duplicate:false,amount,userId};}catch(e){try{await client.query("ROLLBACK")}catch{}throw e;}finally{client.release();}
}
async function getAdminFlutterwaveFundingAccount(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};const r=await db(`SELECT * FROM flutterwave_virtual_accounts WHERE owner_type='admin' AND owner_id=$1 AND account_type='dynamic' AND status='active' AND (expiry_date IS NULL OR expiry_date>NOW()) ORDER BY created_at DESC LIMIT 1`,[String(admin.id)]);return{success:true,account:r.rows[0]||null};}
async function createAdminFlutterwaveFundingAccount(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};const b=await body(req),amount=Number(b.amount);if(!validAmount(amount)||amount<100)return{success:false,statusCode:400,message:"Enter an amount of at least ₦100."};try{return await createFlutterwaveVirtualAccount({ownerType:"admin",ownerId:String(admin.id),user:{name:"BOLTIV TECHNOLOGIES LIMITED",email:admin.email,phone:process.env.ADMIN_PHONE||"08000000000"},accountType:"dynamic",amount});}catch(e){return{success:false,statusCode:400,message:e.message||"Unable to create Flutterwave admin funding account."};}
}

function normalizeNgPhone(phone){
let p=String(phone||"").replace(/\D/g,"");
if(p.startsWith("234")&&p.length===13) p="0"+p.slice(3);
if(p.length===10&&/^[789]/.test(p)) p="0"+p;
return p;
}

function splitName(name,email){
const value=clean(name)||clean(email).split("@")[0]||"BOLTIV User";
const parts=value.split(/\s+/).filter(Boolean);
return {first:parts.shift()||"BOLTIV",last:parts.join(" ")||"User"};
}

function flutterwaveError(r,fallback="Flutterwave request failed."){
const message=r?.data?.message||r?.data?.error||r?.message;
return typeof message==="string"&&message.trim()?message.trim():fallback;
}

async function getFlutterwaveCashReconciliation(req){
const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
if(!flutterwaveConfigured())return{success:false,statusCode:503,message:"Flutterwave is not configured."};
const now=new Date(),from=new Date(now.getTime()-30*24*60*60*1000),iso=d=>d.toISOString().slice(0,10),fromDate=iso(from),toDate=iso(now);
try{
const [balances,local]=await Promise.all([
flutterwaveRequest('/balances'),
db(`SELECT t.id,t.amount,t.reference,t.provider_reference,t.date,t.status,t.metadata,u.email,u.name FROM transactions t LEFT JOIN users u ON u.user_id=t.user_id WHERE t.type='credit' AND t.service='Wallet Funding' AND t.status='successful' AND t.date>=NOW()-INTERVAL '30 days' ORDER BY t.date DESC LIMIT 500`)
]);
if(!balances.success)throw new Error(flutterwaveError(balances,'Unable to fetch Flutterwave balances.'));
const fetchPages=async(base,maxPages=10)=>{const out=[];for(let page=1;page<=maxPages;page++){const r=await flutterwaveRequest(`${base}${base.includes('?')?'&':'?'}page=${page}`);if(!r.success)throw new Error(flutterwaveError(r,'Unable to fetch Flutterwave data.'));const rows=Array.isArray(r.data?.data)?r.data.data:[];out.push(...rows);if(rows.length<10)break;}return out;};
const [collectionRows,settlementRows]=await Promise.all([fetchPages(`/transactions?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}&status=successful&currency=NGN`),fetchPages(`/settlements?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`)]);
const balanceRows=Array.isArray(balances.data?.data)?balances.data.data:[],ngn=balanceRows.find(x=>String(x.currency||'').toUpperCase()==='NGN')||{},localRows=local.rows||[];
const localByRef=new Map();for(const x of localRows){for(const key of [x.provider_reference,x.metadata?.provider_reference,x.metadata?.tx_ref].filter(Boolean))localByRef.set(String(key),x);}
const collections=collectionRows.map(x=>{const ref=String(x.tx_ref||x.flw_ref||x.id||''),match=localByRef.get(ref)||localRows.find(l=>String(l.provider_reference||'')===String(x.id||''));return{id:x.id,tx_ref:x.tx_ref||null,flw_ref:x.flw_ref||null,amount:Number(x.amount||0),amount_settled:Number(x.amount_settled||0),status:String(x.status||''),created_at:x.created_at||x.date||null,customer:x.customer?.email||x.customer?.name||null,boltivReference:match?.reference||null,boltivUser:match?.email||match?.name||null,matched:Boolean(match)};});
const grossCollections=collections.reduce((a,x)=>a+x.amount,0),settledGross=settlementRows.reduce((a,x)=>a+Number(x.gross_amount||x.amount||0),0),settledNet=settlementRows.reduce((a,x)=>a+Number(x.net_amount||0),0),localFunding=localRows.reduce((a,x)=>a+Number(x.amount||0),0),matchedCollections=collections.filter(x=>x.matched).reduce((a,x)=>a+x.amount,0),unmatchedCollections=collections.filter(x=>!x.matched).reduce((a,x)=>a+x.amount,0);
return{success:true,reconciliation:{period:{from:fromDate,to:toDate},flutterwave:{ngnAvailableBalance:Number(ngn.available_balance||0),ngnLedgerBalance:Number(ngn.ledger_balance||0)},collections:{count:collections.length,gross:grossCollections,matchedGross:matchedCollections,unmatchedGross:unmatchedCollections},settlements:{count:settlementRows.length,gross:settledGross,net:settledNet},localFunding:{count:localRows.length,gross:localFunding},difference:{collectionVsSettlement:Number((grossCollections-settledGross).toFixed(2)),flutterwaveAvailableVsLocalFunding:Number((Number(ngn.available_balance||0)-localFunding).toFixed(2))},recentCollections:collections.slice(0,20),recentSettlements:settlementRows.slice(0,20).map(x=>({id:x.id,transaction_date:x.transaction_date||x.created_datetime||x.created_at||null,processed_date:x.processed_date||x.processed_datetime||null,gross_amount:Number(x.gross_amount||x.amount||0),net_amount:Number(x.net_amount||0),status:x.status||null,destination:x.destination||x.settlement_account||null,transaction_count:Number(x.transaction_count||x.charge_count||0)}))}};
}catch(e){console.error('FLUTTERWAVE CASH RECONCILIATION ERROR:',e?.stack||e?.message||e);return{success:false,statusCode:502,message:e?.message||'Unable to reconcile Flutterwave cash and settlements.'};}
}

async function adminRevenue(req,action){
const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
if(action!=="summary")return{success:false,statusCode:404,message:"Revenue withdrawal is disabled in BOLTIV. Use the Flutterwave dashboard for withdrawals."};
await db(`INSERT INTO admin_revenue_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[admin.id]);
const w=(await db(`SELECT balance FROM admin_revenue_wallets WHERE admin_id=$1`,[admin.id])).rows[0];
const r=(await db(`SELECT COALESCE(SUM(CASE WHEN type='sale' THEN amount ELSE 0 END),0) AS sales,COALESCE(SUM(CASE WHEN type='refund' THEN ABS(amount) ELSE 0 END),0) AS refunds FROM admin_revenue_ledger WHERE admin_id=$1`,[admin.id])).rows[0];
const gross=(await db(`SELECT COALESCE(SUM(CASE WHEN type='debit' AND status='successful' THEN COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0) ELSE 0 END),0) AS gross_profit FROM transactions`)).rows[0];
return{success:true,summary:{balance:Number(w?.balance||0),sales:Number(r?.sales||0),refunds:Number(r?.refunds||0),grossProfit:Number(gross?.gross_profit||0)},withdrawalsDisabled:true,withdrawalInstructions:"Withdrawals are handled directly in the Flutterwave dashboard."};
}
async function adminWalletInfo(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};const wallet=await getAdminWallet(admin.id);const ledger=(await db(`SELECT id,type,amount,balance_after,reference,description,created_at FROM admin_wallet_ledger WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 100`,[admin.id])).rows.map(x=>({...x,amount:Number(x.amount||0),balance_after:Number(x.balance_after||0)}));return{success:true,wallet,ledger};}
async function initializeAdminWalletFunding(req){
const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
const b=await body(req),amount=Number(b.amount);if(!validAmount(amount)||amount<100)return{success:false,statusCode:400,message:"Enter an amount of at least ₦100."};
try{return await createFlutterwaveVirtualAccount({ownerType:"admin",ownerId:String(admin.id),user:{name:"BOLTIV TECHNOLOGIES LIMITED",email:admin.email,phone:process.env.ADMIN_PHONE||"08000000000"},accountType:"dynamic",amount});}
catch(e){return{success:false,statusCode:400,message:e.message||"Unable to create Flutterwave admin funding account."};}
}
async function verifyAdminWalletFunding(req){
const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
const b=await body(req),accountNumber=clean(b.accountNumber||b.account_number);if(!accountNumber)return{success:false,statusCode:400,message:"Funding account number is required."};
const r=await db(`SELECT * FROM flutterwave_virtual_accounts WHERE owner_type='admin' AND owner_id=$1 AND account_number=$2 LIMIT 1`,[String(admin.id),accountNumber]);if(!r.rows.length)return{success:false,statusCode:404,message:"Flutterwave admin funding account not found."};
return{success:true,account:r.rows[0],message:"Transfer to this Flutterwave account. The operating wallet will be credited automatically after Flutterwave confirms the transfer."};
}


/* ===================== ADMIN DASHBOARD API HELPERS ===================== */

async function adminCsrfToken(req){
  const sessionToken=getAdminSessionToken(req);
  if(!sessionToken)return null;
  let r=await db(`SELECT csrf_token FROM admin_sessions WHERE token=$1 AND expires_at>NOW()`,[sessionToken]);
  if(!r.rows.length)return null;
  let csrf=r.rows[0].csrf_token;
  if(!csrf){
    csrf=token();
    await db(`UPDATE admin_sessions SET csrf_token=$1 WHERE token=$2`,[csrf,sessionToken]);
  }
  return csrf;
}

async function requireAdmin(req){
  return await adminFromToken(req);
}

async function requireAdminCsrf(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const supplied=String(req.headers["x-admin-csrf"]||"");
  const expected=await adminCsrfToken(req);
  if(!expected||!supplied)return{success:false,statusCode:403,message:"Invalid admin CSRF token."};
  const a=Buffer.from(supplied),b=Buffer.from(expected);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return{success:false,statusCode:403,message:"Invalid admin CSRF token."};
  return{success:true,admin};
}

async function adminMe(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  return{success:true,admin:{id:admin.id,email:admin.email}};
}

async function getFinancialReconciliation(){
const customer=(await db(`SELECT COALESCE(SUM(balance),0) balance FROM wallets`)).rows[0];
const customerLedger=(await db(`SELECT COALESCE(SUM(amount),0) balance FROM financial_ledger WHERE account_type='customer_wallet'`)).rows[0];
const admin=(await db(`SELECT COALESCE(SUM(balance),0) balance FROM admin_wallets`)).rows[0];
const adminLedger=(await db(`SELECT COALESCE(SUM(amount),0) balance FROM financial_ledger WHERE account_type='admin_wallet'`)).rows[0];
const revenue=(await db(`SELECT COALESCE(SUM(balance),0) balance FROM admin_revenue_wallets`)).rows[0];
const revenueLedger=(await db(`SELECT COALESCE(SUM(amount),0) balance FROM financial_ledger WHERE account_type='revenue_wallet'`)).rows[0];
const ledgerStart=(await db(`SELECT MIN(created_at) t FROM financial_ledger WHERE category='opening_balance'`)).rows[0]?.t||null;
const fundingTx=(await db(`SELECT COALESCE(SUM(amount) FILTER(WHERE type='credit' AND status='successful' AND service='Wallet Funding' AND ($1::timestamptz IS NULL OR date>=$1)),0) total FROM transactions`,[ledgerStart])).rows[0];
const fundingLedger=(await db(`SELECT COALESCE(SUM(amount) FILTER(WHERE category='wallet_funding'),0) total FROM financial_ledger WHERE account_type='customer_wallet'`)).rows[0];
const pending=(await db(`SELECT COUNT(*)::int count,COALESCE(SUM(amount),0) amount FROM transactions WHERE status IN ('pending','processing')`)).rows[0];
const out={customerWallet:Number(customer?.balance||0),customerLedger:Number(customerLedger?.balance||0),adminWallet:Number(admin?.balance||0),adminLedger:Number(adminLedger?.balance||0),revenueWallet:Number(revenue?.balance||0),revenueLedger:Number(revenueLedger?.balance||0),fundingTransactions:Number(fundingTx?.total||0),fundingLedger:Number(fundingLedger?.total||0),pendingCount:Number(pending?.count||0),pendingAmount:Number(pending?.amount||0)};
out.customerVariance=Number((out.customerWallet-out.customerLedger).toFixed(2));out.adminVariance=Number((out.adminWallet-out.adminLedger).toFixed(2));out.revenueVariance=Number((out.revenueWallet-out.revenueLedger).toFixed(2));out.fundingVariance=Number((out.fundingTransactions-out.fundingLedger).toFixed(2));out.ok=[out.customerVariance,out.adminVariance,out.revenueVariance,out.fundingVariance].every(v=>Math.abs(v)<0.01);return out;
}
async function upsertPlatformAlert(alertKey,severity,title,message,details={}){
const r=await db(`INSERT INTO platform_alerts(alert_key,severity,title,message,status,details) VALUES($1,$2,$3,$4,'open',$5::jsonb) ON CONFLICT(alert_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,message=EXCLUDED.message,status='open',details=EXCLUDED.details,last_seen_at=NOW(),resolved_at=NULL RETURNING *`,[alertKey,severity,title,message,JSON.stringify(details)]);
const row=r.rows[0];
if(row&&severity==='critical'&&RESEND_API_KEY&&ADMIN_EMAIL){
const last=row.email_sent_at?new Date(row.email_sent_at).getTime():0;
if(!last||Date.now()-last>3600000){try{await sendEmail({to:ADMIN_EMAIL,subject:`BOLTIV ALERT: ${title}`,html:`<h2>${title}</h2><p>${message}</p><pre>${JSON.stringify(details,null,2)}</pre>`});await db(`UPDATE platform_alerts SET email_sent_at=NOW() WHERE alert_key=$1`,[alertKey]);}catch(e){console.error('ALERT EMAIL ERROR',e.message)}}}
return true;
}
async function resolvePlatformAlert(key){await db(`UPDATE platform_alerts SET status='resolved',resolved_at=COALESCE(resolved_at,NOW()) WHERE alert_key=$1 AND status='open'`,[key]);}
async function adminFundingDiagnostics(req){
const admin=await adminFromToken(req);
if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
try{
const txWithoutLedger=(await db(`SELECT t.id,t.reference,t.amount,t.date,t.provider_reference,t.user_id FROM transactions t WHERE t.type='credit' AND t.status='successful' AND t.service='Wallet Funding' AND NOT EXISTS (SELECT 1 FROM financial_ledger l WHERE l.transaction_id=t.id AND l.category='wallet_funding') ORDER BY t.date DESC LIMIT 50`)).rows;
const ledgerWithoutTx=(await db(`SELECT l.id,l.reference,l.amount,l.created_at,l.transaction_id,l.owner_id FROM financial_ledger l WHERE l.category='wallet_funding' AND l.account_type='customer_wallet' AND (l.transaction_id IS NULL OR NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id=l.transaction_id AND t.service='Wallet Funding' AND t.status='successful')) ORDER BY l.created_at DESC LIMIT 50`)).rows;
const affectedUserIds=[...new Set(txWithoutLedger.map(t=>t.user_id))];
let openingBalanceCheck=[];
if(affectedUserIds.length){
openingBalanceCheck=(await db(`SELECT owner_id,amount,created_at FROM financial_ledger WHERE account_type='customer_wallet' AND category='opening_balance' AND owner_id=ANY($1::text[])`,[affectedUserIds])).rows;
}
return{success:true,statusCode:200,explanation:"txWithoutLedger = Wallet Funding transactions with NO matching ledger entry. ledgerWithoutTx = wallet_funding ledger entries with NO matching transaction. openingBalanceCheck = each affected user's opening-balance ledger row (compare its created_at against the transaction dates above to see if it was taken before or after).",txWithoutLedger,ledgerWithoutTx,openingBalanceCheck};
}catch(e){return{success:false,statusCode:200,message:"DIAGNOSTIC CRASHED: "+(e&&e.stack||e&&e.message||String(e))};}
}
async function runPlatformAlerts(){try{const r=await getFinancialReconciliation();const f=(await db(`SELECT COUNT(*) FILTER(WHERE status='failed' AND date>=NOW()-INTERVAL '1 hour')::int failed,COUNT(*) FILTER(WHERE date>=NOW()-INTERVAL '1 hour')::int total FROM transactions`)).rows[0]||{};const failed=Number(f.failed||0),total=Number(f.total||0);const checks=[['recon_customer',Math.abs(r.customerVariance)>=.01,'critical','Customer wallet reconciliation mismatch',`Customer wallet differs from ledger by ₦${Math.abs(r.customerVariance).toFixed(2)}.`,{variance:r.customerVariance}],['recon_admin',Math.abs(r.adminVariance)>=.01,'critical','Admin operating wallet mismatch',`Admin operating wallet differs from ledger by ₦${Math.abs(r.adminVariance).toFixed(2)}.`,{variance:r.adminVariance}],['recon_revenue',Math.abs(r.revenueVariance)>=.01,'critical','Revenue wallet reconciliation mismatch',`Revenue wallet differs from ledger by ₦${Math.abs(r.revenueVariance).toFixed(2)}.`,{variance:r.revenueVariance}],['recon_funding',Math.abs(r.fundingVariance)>=.01,'critical','Funding reconciliation mismatch',`Credited deposits differ from Wallet Funding transactions by ₦${Math.abs(r.fundingVariance).toFixed(2)}.`,{variance:r.fundingVariance}],['vtugate_config',!VTUGATE_API_KEY,'critical','VTUGATE is not configured','The VTUGATE API key is missing from the server environment.',{}],['high_failure_rate',total>=10 && failed/total>=0.2,'warning','High transaction failure rate',`${failed} of ${total} transactions failed in the last hour.`,{failed,total,rate:failed/total}],['stale_pending',r.pendingCount>0 && r.pendingAmount>0,'warning','Pending VTU transactions require attention',`${r.pendingCount} transactions worth ₦${r.pendingAmount.toFixed(2)} remain pending or processing.`,{count:r.pendingCount,amount:r.pendingAmount}]];for(const c of checks){if(c[1])await upsertPlatformAlert(c[0],c[2],c[3],c[4],c[5]);else await resolvePlatformAlert(c[0]);}return r;}catch(e){await upsertPlatformAlert('reconciliation_job','critical','Reconciliation job failed',e.message||'Automated reconciliation failed.',{});return null;}}
async function adminAlerts(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};
  if(action==='list'){
    try{const r=await db(`SELECT id,alert_key,severity,title,message,status,details,first_seen_at,last_seen_at,resolved_at FROM platform_alerts ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,last_seen_at DESC LIMIT 200`);return{success:true,alerts:r.rows};}
    catch(e){console.error('ADMIN ALERT LIST ERROR',e?.stack||e?.message||e);return{success:false,statusCode:500,message:'Unable to load platform alerts right now.'};}
  }
  if(action==='resolve'){const b=await body(req),key=clean(b.alertKey||b.alert_key);if(!key)return{success:false,statusCode:400,message:'Alert key is required.'};try{await resolvePlatformAlert(key);await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[admin.id,'alert_resolved','platform_alert',key,JSON.stringify({}),requestIp(req)]);return{success:true};}catch(e){console.error('ADMIN ALERT RESOLVE ERROR',e?.stack||e?.message||e);return{success:false,statusCode:500,message:'Unable to resolve that alert.'};}}
  if(action==='reconcile'){
    try{const r=await runPlatformAlerts();if(!r)return{success:false,statusCode:500,message:'Reconciliation check failed. Check server logs for details.'};return{success:true,reconciliation:r};}
    catch(e){console.error('ADMIN ALERT RECONCILE ERROR',e?.stack||e?.message||e);return{success:false,statusCode:500,message:'Reconciliation check failed. Check server logs for details.'};}
  }
  return{success:false,statusCode:400,message:'Unsupported alert action.'};
}
async function adminAnalytics(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};const daily=(await db(`WITH d AS (SELECT generate_series(CURRENT_DATE-13,CURRENT_DATE,interval '1 day')::date day) SELECT d.day,COALESCE((SELECT COUNT(*) FROM users u WHERE u.created_at::date=d.day),0)::int users,COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.date::date=d.day),0)::int transactions,COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.date::date=d.day AND t.status='successful'),0)::int successful,COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.date::date=d.day AND t.type='debit' AND t.status='successful'),0) sales,COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.date::date=d.day AND t.type='credit' AND t.service='Wallet Funding' AND t.status='successful'),0) funding,COALESCE((SELECT SUM(ABS(t.amount)) FROM transactions t WHERE t.date::date=d.day AND t.status='refunded'),0) refunds,COALESCE((SELECT SUM(COALESCE((t.metadata->'pricing'->>'grossProfit')::numeric,0)) FROM transactions t WHERE t.date::date=d.day AND t.type='debit' AND t.status='successful'),0) profit FROM d ORDER BY d.day`)).rows;const services=(await db(`SELECT service,COUNT(*)::int transactions,COUNT(*) FILTER(WHERE status='successful')::int successful,COALESCE(SUM(amount) FILTER(WHERE status='successful' AND type='debit'),0) sales,COALESCE(SUM(COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0)) FILTER(WHERE status='successful' AND type='debit'),0) profit FROM transactions WHERE date>=NOW()-INTERVAL '30 days' GROUP BY service ORDER BY sales DESC`)).rows;const topUsers=(await db(`SELECT u.user_id,u.name,u.email,COUNT(t.id)::int transactions,COALESCE(SUM(t.amount) FILTER(WHERE t.type='debit' AND t.status='successful'),0) spend FROM users u JOIN transactions t ON t.user_id=u.user_id WHERE t.date>=NOW()-INTERVAL '30 days' GROUP BY u.user_id,u.name,u.email ORDER BY spend DESC LIMIT 10`)).rows;return{success:true,daily:daily.map(x=>({...x,sales:Number(x.sales||0),funding:Number(x.funding||0),refunds:Number(x.refunds||0),profit:Number(x.profit||0)})),services:services.map(x=>({...x,sales:Number(x.sales||0),profit:Number(x.profit||0)})),topUsers:topUsers.map(x=>({...x,spend:Number(x.spend||0)}))};}

async function adminStatsResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};

  const users=(await db(`SELECT COUNT(*)::int AS count FROM users`)).rows[0];
  const active=(await db(`SELECT COUNT(*)::int AS count FROM users WHERE COALESCE(status,'active')<>'suspended'`)).rows[0];
  const wallet=(await db(`SELECT COALESCE(SUM(balance),0) AS total FROM wallets`)).rows[0];
  const tx=(await db(`SELECT COUNT(*)::int AS count FROM transactions`)).rows[0];
  const payments=(await db(`SELECT COUNT(*)::int AS count FROM payments`)).rows[0];
  const statuses=(await db(`SELECT
    COUNT(*) FILTER(WHERE status='successful')::int AS successful,
    COUNT(*) FILTER(WHERE status IN ('pending','processing'))::int AS pending,
    COUNT(*) FILTER(WHERE status='failed')::int AS failed,
    COALESCE(SUM(CASE WHEN type='debit' AND status='successful'
      THEN COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0) ELSE 0 END),0) AS gross_profit
    FROM transactions`)).rows[0];

  await db(`INSERT INTO admin_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[admin.id]);
  await db(`INSERT INTO admin_revenue_wallets(admin_id,balance) VALUES($1,0) ON CONFLICT(admin_id) DO NOTHING`,[admin.id]);
  const aw=(await db(`SELECT balance FROM admin_wallets WHERE admin_id=$1`,[admin.id])).rows[0];
  const rw=(await db(`SELECT balance FROM admin_revenue_wallets WHERE admin_id=$1`,[admin.id])).rows[0];

  return{
    success:true,
    stats:{
      users:Number(users?.count||0),
      walletBalance:Number(wallet?.total||0),
      transactions:Number(tx?.count||0),
      payments:Number(payments?.count||0),
      grossProfit:Number(statuses?.gross_profit||0),
      successful:Number(statuses?.successful||0),
      pending:Number(statuses?.pending||0),
      failed:Number(statuses?.failed||0),
      activeUsers:Number(active?.count||0),
      adminWalletBalance:Number(aw?.balance||0),
      adminRevenueBalance:Number(rw?.balance||0)
    }
  };
}

async function adminUsersResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const r=await db(`SELECT u.user_id,u.name,u.email,u.phone,COALESCE(u.status,'active') AS status,
    COALESCE(w.balance,0) AS balance,u.created_at
    FROM users u LEFT JOIN wallets w ON w.user_id=u.user_id
    ORDER BY u.created_at DESC LIMIT 1000`);
  return{success:true,users:r.rows.map(x=>({...x,balance:Number(x.balance||0)}))};
}

async function adminTransactionsResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const r=await db(`SELECT t.id,t.user_id,t.type,t.service,t.amount,t.reference,t.status,t.date,
    t.provider_reference,t.metadata,u.email,u.name,
    COALESCE((t.metadata->'pricing'->>'providerCost')::numeric,0) AS provider_cost,
    COALESCE((t.metadata->'pricing'->>'grossProfit')::numeric,0) AS gross_profit
    FROM transactions t LEFT JOIN users u ON u.user_id=t.user_id
    ORDER BY t.date DESC LIMIT 1000`);
  return{success:true,transactions:r.rows.map(x=>({...x,amount:Number(x.amount||0),providerCost:Number(x.provider_cost||0),grossProfit:Number(x.gross_profit||0)}))};
}

async function adminPaymentsResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};

  try{
    // Primary source: the dedicated payments table.
    const r=await db(`SELECT p.id,p.reference,p.user_id,COALESCE(NULLIF(p.email,''),u.email,'') AS email,
      COALESCE(p.amount,0) AS amount,COALESCE(p.amount_kobo,0) AS amount_kobo,
      COALESCE(p.status,'pending') AS status,COALESCE(p.credited,FALSE) AS credited,
      COALESCE(p.created_at,NOW()) AS created_at,p.credited_at
      FROM payments p
      LEFT JOIN users u ON u.user_id=p.user_id
      ORDER BY p.created_at DESC NULLS LAST,p.id DESC LIMIT 1000`);

    if(r.rows.length){
      return{success:true,payments:r.rows.map(x=>({...x,
        amount:Number(x.amount||0),amount_kobo:Number(x.amount_kobo||0),credited:Boolean(x.credited)
      }))};
    }

    // Some deployments record wallet deposits in transactions rather than payments.
    // Use those records so the admin panel does not appear broken when the payments
    // table is empty but real wallet funding exists.
    const fallback=await db(`SELECT t.id,t.reference,t.user_id,COALESCE(u.email,'') AS email,
      COALESCE(t.amount,0) AS amount,COALESCE(t.amount,0)*100 AS amount_kobo,
      CASE WHEN t.status='successful' THEN 'success' ELSE t.status END AS status,
      CASE WHEN t.status='successful' THEN TRUE ELSE FALSE END AS credited,
      t.date AS created_at,t.completed_at AS credited_at
      FROM transactions t
      LEFT JOIN users u ON u.user_id=t.user_id
      WHERE t.type='credit' AND LOWER(COALESCE(t.service,''))='wallet funding'
      ORDER BY t.date DESC LIMIT 1000`);

    return{success:true,payments:fallback.rows.map(x=>({...x,
      amount:Number(x.amount||0),amount_kobo:Number(x.amount_kobo||0),credited:Boolean(x.credited)
    }))};
  }catch(e){
    console.error('ADMIN PAYMENTS ERROR',e?.stack||e?.message||e);
    try{
      const fallback=await db(`SELECT t.id,t.reference,t.user_id,COALESCE(u.email,'') AS email,
        COALESCE(t.amount,0) AS amount,COALESCE(t.amount,0)*100 AS amount_kobo,
        CASE WHEN t.status='successful' THEN 'success' ELSE t.status END AS status,
        CASE WHEN t.status='successful' THEN TRUE ELSE FALSE END AS credited,
        t.date AS created_at,t.completed_at AS credited_at
        FROM transactions t LEFT JOIN users u ON u.user_id=t.user_id
        WHERE t.type='credit' AND LOWER(COALESCE(t.service,''))='wallet funding'
        ORDER BY t.date DESC LIMIT 1000`);
      return{success:true,payments:fallback.rows.map(x=>({...x,
        amount:Number(x.amount||0),amount_kobo:Number(x.amount_kobo||0),credited:Boolean(x.credited)
      }))};
    }catch(fallbackError){
      console.error('ADMIN PAYMENTS FALLBACK ERROR',fallbackError?.stack||fallbackError?.message||fallbackError);
      return{success:false,statusCode:500,message:'Unable to load payment history right now.'};
    }
  }
}
async function adminMonitoring(req){
  const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const started=Date.now();let database="connected";try{await db("SELECT 1")}catch{database="unavailable"}
  let d={};try{d=(await db(`SELECT COUNT(*) FILTER (WHERE status IN ('processing','pending'))::int pending,COUNT(*) FILTER (WHERE status IN ('processing','pending') AND date<NOW()-INTERVAL '10 minutes')::int stale_pending,COUNT(*) FILTER (WHERE status='failed' AND date>=NOW()-INTERVAL '1 hour')::int failed_last_hour,COUNT(*) FILTER (WHERE status='successful' AND date>=NOW()-INTERVAL '24 hours')::int successful_last_24h,COUNT(*) FILTER (WHERE status IN ('failed','refunded') AND date>=NOW()-INTERVAL '24 hours')::int unsuccessful_last_24h,MAX(date) FILTER (WHERE status='successful') last_successful FROM transactions`)).rows[0]||{}}catch{return{success:false,statusCode:500,message:"Unable to load monitoring metrics."}}
  const total=Number(d.successful_last_24h||0)+Number(d.unsuccessful_last_24h||0);const rate=total?Math.round(Number(d.successful_last_24h||0)/total*1000)/10:100;
  return{success:true,monitoring:{database,vtugate:Boolean(VTUGATE_API_KEY&&VTUGATE_API_BASE_URL),pending:Number(d.pending||0),stalePending:Number(d.stale_pending||0),failedLastHour:Number(d.failed_last_hour||0),successfulLast24h:Number(d.successful_last_24h||0),unsuccessfulLast24h:Number(d.unsuccessful_last_24h||0),successRate:rate,lastSuccessful:d.last_successful||null,responseMs:Date.now()-started,timestamp:new Date().toISOString()}};
}

async function adminVTUGATEProvider(req,action,network){
let admin;
try{admin=await adminFromToken(req);}
catch(e){return{success:false,statusCode:200,message:"ADMIN AUTH CHECK CRASHED: "+(e&&e.stack||e&&e.message||String(e))};}
if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
if(action==="account"){const r=await getVTUGATEAccountDetails();return{success:r.success,statusCode:r.statusCode,message:r.message||"",account:r.data?.data||r.data||null};}
if(action==="services"){const r=await fetchVTUGATEServices(true);return{success:r.success,statusCode:r.statusCode,message:r.message||"",services:r.data?.data||r.data?.services||r.data||[]};}
if(action==="rawplans"){
try{
const selected=normalizeDataNetwork(network||"MTN")||"MTN";
let serviceIds=[];
try{serviceIds=await getVTUGATEDataServiceIds(selected);}
catch(e){return{success:false,statusCode:200,message:"COULD NOT FIND A SERVICE ID FOR THIS NETWORK: "+(e&&e.message||String(e)),network:selected,serviceIdsTried:[],results:[]};}
const results=[];
for(const serviceId of serviceIds){
try{
const r=await vtugateRequest("api/v1/fetchdataplans",{service_id:serviceId});
results.push({serviceId,success:r.success,statusCode:r.statusCode,message:r.message,raw:r.data});
}catch(inner){
results.push({serviceId,success:false,error:"THIS SERVICE ID THREW AN ERROR: "+(inner&&inner.message||String(inner))});
}
}
return{success:true,statusCode:200,network:selected,serviceIdsTried:serviceIds,results};
}catch(outer){
return{success:false,statusCode:200,message:"DIAGNOSTIC CRASHED: "+(outer&&outer.stack||outer&&outer.message||String(outer))};
}
}
return{success:false,statusCode:400,message:"Unsupported VTUGATE provider action."};
}

async function adminSupport(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="list"){
    const r=await db(`SELECT t.id,t.user_id,t.subject,t.message,t.status,t.transaction_reference,t.created_at,t.updated_at,u.name,u.email
      FROM support_tickets t LEFT JOIN users u ON u.user_id=t.user_id
      ORDER BY t.updated_at DESC LIMIT 200`);
    return{success:true,tickets:r.rows};
  }
  const b=await body(req);
  const ticketId=Number(b.ticketId||b.ticket_id);
  if(!Number.isInteger(ticketId)||ticketId<1)return{success:false,statusCode:400,message:"Invalid ticket."};
  if(action==="status"){
    const status=clean(b.status).toLowerCase();
    if(!["open","pending","resolved","closed"].includes(status))return{success:false,statusCode:400,message:"Invalid ticket status."};
    const r=await db(`UPDATE support_tickets SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status,user_id`,[status,ticketId]);
    if(!r.rows.length)return{success:false,statusCode:404,message:"Support ticket not found."};
    try{await addNotification(r.rows[0].user_id,"Support ticket updated",`Ticket #${ticketId} is now ${status}.`,"support");}catch{}
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [admin.id,"support_status","ticket",String(ticketId),JSON.stringify({status}),requestIp(req)]);
    return{success:true,ticket:r.rows[0]};
  }
  if(action==="reply"){
    const message=clean(b.message);
    if(message.length<1)return{success:false,statusCode:400,message:"Reply message is required."};
    const t=await db(`SELECT id,user_id FROM support_tickets WHERE id=$1`,[ticketId]);
    if(!t.rows.length)return{success:false,statusCode:404,message:"Support ticket not found."};
    await db(`INSERT INTO support_messages(ticket_id,sender_type,sender_id,message) VALUES($1,'admin',$2,$3)`,[ticketId,String(admin.id),message]);
    await db(`UPDATE support_tickets SET status='pending',updated_at=NOW() WHERE id=$1`,[ticketId]);
    try{await addNotification(t.rows[0].user_id,"Support replied",`There is a new reply on support ticket #${ticketId}.`,"support");}catch{}
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [admin.id,"support_reply","ticket",String(ticketId),JSON.stringify({message}),requestIp(req)]);
    return{success:true,message:"Reply sent."};
  }
  return{success:false,statusCode:400,message:"Unsupported support action."};
}

async function adminAuditResponse(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const r=await db(`SELECT l.id,l.admin_id,a.email,l.action,l.target_type,l.target_id,l.details,l.ip,l.created_at
    FROM admin_audit_logs l LEFT JOIN admins a ON a.id=l.admin_id
    ORDER BY l.created_at DESC LIMIT 500`);
  return{success:true,logs:r.rows};
}

async function adminServices(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="list"){
    const r=await db(`SELECT key,name,icon,enabled,fee,maintenance,config,updated_at FROM services ORDER BY name`);
    return{success:true,services:r.rows.map(x=>({...x,fee:Number(x.fee||0),config:x.config||{}}))};
  }
  const b=await body(req),key=clean(b.key);
  if(!key)return{success:false,statusCode:400,message:"Service key is required."};
  const r=await db(`UPDATE services SET enabled=$1,maintenance=$2,fee=$3,config=$4::jsonb,updated_at=NOW() WHERE key=$5 RETURNING key,name,icon,enabled,fee,maintenance,config,updated_at`,
    [Boolean(b.enabled),Boolean(b.maintenance),Number(b.fee||0),JSON.stringify(b.config||{}),key]);
  if(!r.rows.length)return{success:false,statusCode:404,message:"Service not found."};
  await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
    [admin.id,"service_update","service",key,JSON.stringify({enabled:Boolean(b.enabled),maintenance:Boolean(b.maintenance),fee:Number(b.fee||0)}),requestIp(req)]);
  return{success:true,service:{...r.rows[0],fee:Number(r.rows[0].fee||0)}};
}

async function adminSettings(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="get"){
    const r=await db(`SELECT key,value FROM platform_settings`);
    const settings={};
    for(const row of r.rows)settings[row.key]=row.value;
    return{success:true,settings};
  }
  const b=await body(req);
  for(const key of ["maintenance_mode","registration_enabled"]){
    if(Object.prototype.hasOwnProperty.call(b,key)){
      await db(`INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,
        [key,JSON.stringify(Boolean(b[key]))]);
    }
  }
  for(const key of ["announcement_enabled","announcement_text","announcement_items"]){
    if(Object.prototype.hasOwnProperty.call(b,key)){
      let value;
      if(key==="announcement_enabled") value=Boolean(b[key]);
      else if(key==="announcement_text") value=String(b[key]||"").trim().slice(0,240);
      else {
        const items=Array.isArray(b[key])?b[key]:[];
        value=items.map(x=>({text:String(x?.text||"").trim().slice(0,240),enabled:x?.enabled!==false})).filter(x=>x.text).slice(0,10);
        if(!value.length) value=[{text:"Welcome to BOLTIV — Fast. Simple. Powerful.",enabled:true}];
      }
      await db(`INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,[key,JSON.stringify(value)]);
    }
  }
  return adminSettings(req,"get");
}

async function adminSecurity(req,action){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==="events"){
    const r=await db(`SELECT s.id,s.admin_id,a.email,s.event_type,s.severity,s.details,s.ip,s.created_at
      FROM security_events s LEFT JOIN admins a ON a.id=s.admin_id
      ORDER BY s.created_at DESC LIMIT 500`);
    return{success:true,events:r.rows};
  }
  if(action==="sessions"){
    const r=await db(`SELECT s.created_at,s.expires_at,a.email,s.admin_id
      FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
      WHERE s.expires_at>NOW() ORDER BY s.created_at DESC`);
    return{success:true,sessions:r.rows};
  }
  if(action==="revoke"){
    const current=getAdminSessionToken(req);
    const r=await db(`DELETE FROM admin_sessions WHERE admin_id=$1 AND token<>$2`,[admin.id,current||""]);
    await recordSecurityEvent("admin_sessions_revoked","warning",{revoked:r.rowCount},req,admin.id);
    return{success:true,revoked:r.rowCount||0};
  }
  return{success:false,statusCode:400,message:"Unsupported security action."};
}

async function adminUserAction(req){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const b=await body(req),userId=clean(b.userId||b.user_id),action=clean(b.action).toLowerCase();
  if(!userId||!["suspend","activate"].includes(action))return{success:false,statusCode:400,message:"Invalid user action."};
  const status=action==="suspend"?"suspended":"active";
  const r=await db(`UPDATE users SET status=$1,updated_at=NOW() WHERE user_id=$2 RETURNING user_id,status`,[status,userId]);
  if(!r.rows.length)return{success:false,statusCode:404,message:"User not found."};
  await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
    [admin.id,action,"user",userId,JSON.stringify({status}),requestIp(req)]);
  return{success:true,user:r.rows[0]};
}

async function adminWalletAdjust(req,mode){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const b=await body(req),userId=clean(b.userId||b.user_id),amount=Number(b.amount),reason=clean(b.reason)||`Admin ${mode}`;
  if(!userId||!validAmount(amount))return{success:false,statusCode:400,message:"Valid user ID and amount are required."};
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const u=await client.query(`SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE`,[userId]);
    if(!u.rows.length){await client.query("ROLLBACK");return{success:false,statusCode:404,message:"User not found."};}
    await client.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`,[userId]);
    const w=await client.query(`SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE`,[userId]);
    const old=Number(w.rows[0].balance||0),delta=mode==="credit"?amount:-amount,next=old+delta;
    if(next<0){await client.query("ROLLBACK");return{success:false,statusCode:400,message:"Insufficient wallet balance."};}
    await client.query(`UPDATE wallets SET balance=$1,updated_at=NOW() WHERE user_id=$2`,[next,userId]);
    const adjRef=`ADMIN-${mode.toUpperCase()}-${reference("WALLET")}`;
    await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:userId,direction:delta>=0?"credit":"debit",amount:delta,balanceAfter:next,reference:adjRef,category:`admin_wallet_${mode}`,description:reason,metadata:{admin_id:admin.id}});
    await client.query("COMMIT");
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [admin.id,`wallet_${mode}`,"user",userId,JSON.stringify({amount,reason,balance_after:next}),requestIp(req)]);
    return{success:true,message:"Wallet updated.",balance:next};
  }catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}


async function handleAdminRoutes(
req,
res,
path
){

/*
ADMIN LOGIN
*/

if(
req.method==="POST"&&
path==="/api/admin/login"
){

const b=
await body(req);

const result=
await adminLogin(
b.email,
b.password,req
);

if(result.success&&result.token){
setAdminSessionCookie(res,result.token);
const safeResult={...result};
delete safeResult.token;
return send(res,200,safeResult);
}

return send(
res,
result.success?200:401,
result
);

}

if(req.method==="GET"&&path==="/api/admin/csrf"){
const admin=await adminFromToken(req);
if(!admin)return send(res,401,{success:false,message:"Unauthorized."});
const csrf=await adminCsrfToken(req);
return send(res,200,{success:true,csrfToken:csrf});
}

const isAdminRoute = path === "/api/admin" || path.startsWith("/api/admin/");

if(isAdminRoute&&req.method!=="GET"&&req.method!=="HEAD"&&path!=="/api/admin/login"){
const csrfCheck=await requireAdminCsrf(req);
if(!csrfCheck.success)return send(res,csrfCheck.statusCode||403,csrfCheck);
}

/*
ADMIN SESSION CHECK
*/

if(
req.method==="GET"&&
path==="/api/admin/me"
){

const result=
await adminMe(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


/*
ADMIN STATS
*/

if(
req.method==="GET"&&
path==="/api/admin/stats"
){

const result=
await adminStatsResponse(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


/*
ADMIN USERS
*/

if(
req.method==="GET"&&
path==="/api/admin/users"
){

const result=
await adminUsersResponse(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


/*
ADMIN TRANSACTIONS
*/

if(
req.method==="GET"&&
path==="/api/admin/transactions"
){

const result=
await adminTransactionsResponse(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


/*
ADMIN PAYMENTS
*/

if(
req.method==="GET"&&
path==="/api/admin/payments"
){

const result=
await adminPaymentsResponse(req);

return send(
res,
result.success?
200:
(result.statusCode||401),
result
);

}


if(req.method==="GET"&&path==="/api/admin/wallet"){const result=await adminWalletInfo(req);return send(res,result.success?200:(result.statusCode||400),result);}if(req.method==="GET"&&path==="/api/admin/wallet/funding-account"){const result=await getAdminFlutterwaveFundingAccount(req);return send(res,result.success?200:(result.statusCode||400),result);}if(req.method==="POST"&&path==="/api/admin/wallet/funding-account"){const result=await createAdminFlutterwaveFundingAccount(req);return send(res,result.success?200:(result.statusCode||400),result);}if(req.method==='GET'&&path==='/api/admin/revenue'){const result=await adminRevenue(req,'summary');return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==='GET'&&path==='/api/admin/flutterwave/reconciliation'){const result=await getFlutterwaveCashReconciliation(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/fund/initialize"){const result=await initializeAdminWalletFunding(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/fund/verify"){const result=await verifyAdminWalletFunding(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/users/action"){const result=await adminUserAction(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/credit"){const result=await adminWalletAdjust(req,"credit");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/wallet/debit"){const result=await adminWalletAdjust(req,"debit");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/transactions/pending"){const admin=await requireAdmin(req); if(!admin)return; const result=await reconcilePendingTransactions(admin,req); return send(res,200,result);}
if(req.method==="POST"&&path==="/api/admin/transactions/refund"){const result=await adminRefund(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/notifications"){const result=await adminNotifications(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/monitoring"){const result=await adminMonitoring(req);return send(res,result.success?200:(result.statusCode||400),result);}if(req.method==="GET"&&path==="/api/admin/vtugate/account"){const result=await adminVTUGATEProvider(req,"account");return send(res,result.success?200:(result.statusCode||400),result);}if(req.method==="GET"&&path==="/api/admin/vtugate/services"){const result=await adminVTUGATEProvider(req,"services");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/vtugate/rawplans"){const qNetwork=new URL(req.url,"http://localhost").searchParams.get("network");const result=await adminVTUGATEProvider(req,"rawplans",qNetwork);return send(res,result.statusCode||200,result);}
if(req.method==="GET"&&path==="/api/admin/diagnostics/funding"){const result=await adminFundingDiagnostics(req);return send(res,result.statusCode||200,result);}
if(req.method==="GET"&&path==="/api/admin/analytics"){const result=await adminAnalytics(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/reconciliation"){const admin=await adminFromToken(req);if(!admin)return;const result=await getFinancialReconciliation();return send(res,200,{success:true,reconciliation:result});}
if(req.method==="GET"&&path==="/api/admin/ledger"){const admin=await adminFromToken(req);if(!admin)return;const r=await db(`SELECT id,account_type,owner_id,direction,amount,balance_after,reference,transaction_id,category,description,created_at FROM financial_ledger ORDER BY created_at DESC LIMIT 300`);return send(res,200,{success:true,ledger:r.rows.map(x=>({...x,amount:Number(x.amount||0),balance_after:Number(x.balance_after||0)}))});}
if(req.method==="GET"&&path==="/api/admin/alerts"){const result=await adminAlerts(req,"list");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/alerts/reconcile"){const result=await adminAlerts(req,"reconcile");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/alerts/resolve"){const result=await adminAlerts(req,"resolve");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/support"){const result=await adminSupport(req,"list");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/support/reply"){const result=await adminSupport(req,"reply");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/support/status"){const result=await adminSupport(req,"status");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/audit"){const result=await adminAuditResponse(req);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/services"){const result=await adminServices(req,"list");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="PATCH"&&path==="/api/admin/services"){const result=await adminServices(req,"update");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/settings"){const result=await adminSettings(req,"get");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="PATCH"&&path==="/api/admin/settings"){const result=await adminSettings(req,"update");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/security/events"){const result=await adminSecurity(req,"events");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/security/sessions"){const result=await adminSecurity(req,"sessions");return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="POST"&&path==="/api/admin/security/revoke-sessions"){const result=await adminSecurity(req,"revoke");return send(res,result.success?200:(result.statusCode||400),result);}

/*
ADMIN LOGOUT
*/

if(
req.method==="POST"&&
path==="/api/admin/logout"
){
const result=
await logoutAdmin(req);
clearAdminSessionCookie(res);

return send(
res,
200,
result
);

}

return null;

}


async function requestTransactionPinReset(email){
  email=clean(email).toLowerCase();
  const genericMessage="If an account exists for that email, a Transaction PIN reset code has been sent.";
  if(!validEmail(email)) return {success:true,message:genericMessage};

  const result=await db(`SELECT user_id,name,email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,[email]);
  if(!result.rows.length) return {success:true,message:genericMessage};
  const user=result.rows[0];

  await db(`UPDATE transaction_pin_reset_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE`,[user.user_id]);

  const code=String(crypto.randomInt(0,1000000)).padStart(6,"0");
  const codeHash=hashResetToken(code);
  await db(`INSERT INTO transaction_pin_reset_tokens(user_id,code_hash,expires_at,attempts,used,created_at) VALUES($1,$2,NOW()+INTERVAL '10 minutes',0,FALSE,NOW())`,[user.user_id,codeHash]);

  const displayName=clean(user.name)||"BOLTIV User";
  const emailResult=await sendEmail({
    to:user.email,
    subject:"BOLTIV Transaction PIN Reset Code",
    html:`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#171717"><div style="max-width:520px;margin:40px auto;background:#fff;border-radius:18px;padding:32px;border:1px solid #e7e7e7"><div style="font-size:28px;font-weight:900;letter-spacing:4px;color:#c49a25;text-align:center">BOLTIV</div><h2 style="text-align:center;margin-top:28px">Reset your Transaction PIN</h2><p style="font-size:15px;line-height:1.7;color:#555">Hello ${escapeHtmlEmail(displayName)},</p><p style="font-size:15px;line-height:1.7;color:#555">We received a request to reset the Transaction PIN on your BOLTIV account. Enter the verification code below to create a new 4-digit Transaction PIN.</p><div style="margin:28px 0;text-align:center"><div style="display:inline-block;padding:16px 26px;border-radius:12px;background:#fff9e6;border:1px solid #d4af37;font-size:30px;letter-spacing:8px;font-weight:900;color:#171717">${code}</div></div><p style="font-size:13px;line-height:1.6;color:#777">This code expires in 10 minutes and can only be used once. You have a limited number of verification attempts.</p><p style="font-size:13px;line-height:1.6;color:#777">If you did not request this change, secure your account and contact BOLTIV support.</p></div></body></html>`
  });

  if(!emailResult.success){
    console.error("TRANSACTION PIN RESET EMAIL FAILED:",emailResult.message);
    await db(`DELETE FROM transaction_pin_reset_tokens WHERE user_id=$1 AND code_hash=$2`,[user.user_id,codeHash]).catch(e=>console.error("TRANSACTION PIN RESET TOKEN CLEANUP FAILED:",e));
    return {success:false,message:"We couldn't send the Transaction PIN reset code right now. Please try again later."};
  }
  return {success:true,message:genericMessage};
}

async function resetTransactionPin(email,code,newPin){
  email=clean(email).toLowerCase();
  code=String(code||"").trim();
  newPin=String(newPin||"").trim();
  if(!validEmail(email)||!/^[0-9]{6}$/.test(code)||!/^[0-9]{4}$/.test(newPin)) return {success:false,message:"Enter a valid email, 6-digit verification code, and 4-digit Transaction PIN."};

  const userResult=await db(`SELECT user_id,name,email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,[email]);
  if(!userResult.rows.length) return {success:false,message:"The verification code is invalid or has expired."};
  const user=userResult.rows[0];
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const tokenResult=await client.query(`SELECT id,code_hash,expires_at,attempts FROM transaction_pin_reset_tokens WHERE user_id=$1 AND used=FALSE AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[user.user_id]);
    if(!tokenResult.rows.length){await client.query("ROLLBACK");return {success:false,message:"The verification code is invalid or has expired."};}
    const token=tokenResult.rows[0];
    if(Number(token.attempts)>=5){await client.query(`UPDATE transaction_pin_reset_tokens SET used=TRUE WHERE id=$1`,[token.id]);await client.query("COMMIT");return {success:false,message:"Too many verification attempts. Please request a new code."};}
    if(hashResetToken(code)!==token.code_hash){
      const attempts=Number(token.attempts)+1;
      await client.query(`UPDATE transaction_pin_reset_tokens SET attempts=$1,used=CASE WHEN $1>=5 THEN TRUE ELSE used END WHERE id=$2`,[attempts,token.id]);
      await client.query("COMMIT");
      return {success:false,message:attempts>=5?"Too many verification attempts. Please request a new code.":"Incorrect verification code."};
    }
    const pinHash=hashPassword(newPin);
    await client.query(`INSERT INTO user_security(user_id,transaction_pin_hash,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET transaction_pin_hash=EXCLUDED.transaction_pin_hash,updated_at=NOW()`,[user.user_id,pinHash]);
    await client.query(`UPDATE transaction_pin_reset_tokens SET used=TRUE WHERE id=$1`,[token.id]);
    await client.query(`UPDATE transaction_pin_reset_tokens SET used=TRUE WHERE user_id=$1 AND used=FALSE`,[user.user_id]);
    await client.query("COMMIT");
  }catch(error){
    await client.query("ROLLBACK");
    console.error("TRANSACTION PIN RESET ERROR:",error?.stack||error?.message||error);
    return {success:false,message:"Unable to reset your Transaction PIN right now."};
  }finally{client.release();}

  const notice=await sendEmail({
    to:user.email,
    subject:"BOLTIV Transaction PIN Changed",
    html:`<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#171717"><div style="max-width:520px;margin:40px auto;background:#fff;border-radius:18px;padding:32px;border:1px solid #e7e7e7"><div style="font-size:28px;font-weight:900;letter-spacing:4px;color:#c49a25;text-align:center">BOLTIV</div><h2 style="text-align:center;margin-top:28px">Transaction PIN changed</h2><p style="font-size:15px;line-height:1.7;color:#555">Hello ${escapeHtmlEmail(user.name||"BOLTIV User")}, your BOLTIV Transaction PIN was successfully changed.</p><p style="font-size:13px;line-height:1.6;color:#777">If you did not make this change, contact BOLTIV support immediately and secure your account.</p></div></body></html>`
  });
  if(!notice.success) console.error("TRANSACTION PIN CHANGE NOTICE FAILED:",notice.message);
  return {success:true,message:"Transaction PIN reset successfully. Your new PIN is now active."};
}

async function handlePasswordRoutes(
req,
res,
path
){

/*
FORGOT TRANSACTION PIN
*/
if(req.method==="POST"&&path==="/api/auth/forgot-transaction-pin"){
  const b=await body(req);
  const email=clean(b.email).toLowerCase();
  const rl=rateLimit(req,`forgot-transaction-pin:${email||"unknown"}`,3,15*60*1000);
  if(!rl.allowed)return rateLimitedResponse(res,rl);
  const result=await requestTransactionPinReset(email);
  return send(res,result.success?200:400,result);
}

/*
RESET TRANSACTION PIN
*/
if(req.method==="POST"&&path==="/api/auth/reset-transaction-pin"){
  const b=await body(req);
  const email=clean(b.email).toLowerCase();
  const rl=rateLimit(req,`reset-transaction-pin:${email||"unknown"}`,10,15*60*1000);
  if(!rl.allowed)return rateLimitedResponse(res,rl);
  const result=await resetTransactionPin(email,b.code,b.pin);
  return send(res,result.success?200:400,result);
}

/*
FORGOT PASSWORD
*/

if(
req.method==="POST"&&
path==="/api/auth/forgot-password"
){
const rl=rateLimit(req,"forgot-password",5,15*60*1000);if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=
await body(req);

const result=
await requestPasswordReset(
b.email
);

return send(
res,
result.success?
200:
400,
result
);

}


/*
RESET PASSWORD
*/

if(
req.method==="POST"&&
path==="/api/auth/reset-password"
){
const rl=rateLimit(req,"reset-password",8,15*60*1000);if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=
await body(req);

const result=
await resetPassword(
b.token,
b.password
);

return send(
res,
result.success?
200:
400,
result
);

}

return null;

}


async function handleAuthRoutes(
req,
res,
path,
url
){

/*
REGISTER
*/

if(
req.method==="POST"&&
path==="/api/auth/register"
){
const rl=rateLimit(req,"register",5,15*60*1000);if(!rl.allowed)return rateLimitedResponse(res,rl);
if(!Boolean(await getPlatformSetting('registration_enabled',true)))return send(res,403,{success:false,message:'New user registration is currently disabled.'});
const b=
await body(req);

const result=
await registerUser(
b.email,
b.password,
b.name,
b.phone,
b.termsAccepted
);
if(result.success && result._sessionToken){ setUserSessionCookie(res,result._sessionToken); result.sessionToken=result._sessionToken; delete result._sessionToken; }
return send(
res,
result.success?
201:
400,
result
);

}


/*
EMAIL VERIFICATION
*/
if(req.method==="GET"&&path==="/api/auth/verify-email"){
  const result=await verifyEmailToken(url.searchParams.get("token"));
  return send(res,result.success?200:400,result);
}

if(req.method==="POST"&&path==="/api/auth/resend-verification"){
  const rl=rateLimit(req,"resend-verification",3,15*60*1000);
  if(!rl.allowed)return rateLimitedResponse(res,rl);
  const b=await body(req);
  const email=clean(b.email).toLowerCase();
  if(!validEmail(email))return send(res,400,{success:false,message:"Please enter a valid email address."});
  const r=await db(`SELECT id,user_id,name,email,email_verified FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,[email]);
  if(!r.rows.length||r.rows[0].email_verified)return send(res,200,{success:true,message:"If the account requires verification, a new verification email has been sent."});
  const result=await sendVerificationEmail(r.rows[0]);
  return send(res,result.success?200:503,{success:result.success,message:result.success?"A new verification email has been sent.":"Unable to send the verification email right now. Please try again later."});
}

/*
LOGIN
*/

if(
req.method==="POST"&&
path==="/api/auth/login"
){
const rl=rateLimit(req,"login",10,15*60*1000);if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=
await body(req);

const result=
await loginUser(
b.email,
b.password
);
if(result.success && result._sessionToken){ setUserSessionCookie(res,result._sessionToken); result.sessionToken=result._sessionToken; delete result._sessionToken; }
return send(
res,
result.success?
200:
401,
result
);

}


/*
CURRENT USER
*/
if(req.method==="GET"&&path==="/api/auth/me"){
  const user=await userFromToken(req);
  if(!user)return send(res,401,{success:false,message:"Unauthorized."});
  return send(res,200,{success:true,user:{id:user.user_id,userId:user.user_id,name:user.name||"",phone:user.phone||"",email:user.email||""}});
}

/*
LOGOUT
*/

if(
req.method==="POST"&&
path==="/api/auth/logout"
){

const result=
await logoutUser(req,res);

return send(
res,
200,
result
);

}

return null;

}


async function handleExtraUserRoutes(req,res,path,url){
const user=await userFromToken(req);
if(!user) return null;
if(req.method==="GET"&&path==="/api/security"){
const security=await getSecurity(user.user_id); return send(res,200,{success:true,transactionPinSet:Boolean(security?.transaction_pin_hash)});
}
if(req.method==="POST"&&path==="/api/security/transaction-pin"){
const rl=rateLimit(req,`transaction-pin-change:${user.user_id}`,5,15*60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=await body(req); const result=await setTransactionPin(user.user_id,b.pin,b.currentPin||""); return send(res,result.success?200:400,result);
}
if(req.method==="POST"&&path==="/api/security/verify-pin"){
// Used by the inactivity lock screen — confirms the entered PIN matches the
// stored one without performing any wallet action. Rate-limited the same way
// as a PIN change, since a 4-digit PIN only has 10,000 combinations.
const rl=rateLimit(req,`verify-pin:${user.user_id}`,5,15*60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=await body(req);
const pin=clean(b.pin);
if(!/^\d{4}$/.test(pin))return send(res,400,{success:false,message:"Enter your 4-digit PIN."});
const security=await getSecurity(user.user_id);
if(!security?.transaction_pin_hash)return send(res,400,{success:false,message:"No Transaction PIN is set on this account."});
if(!verifyPassword(pin,security.transaction_pin_hash))return send(res,401,{success:false,message:"Incorrect PIN."});
return send(res,200,{success:true});
}
/*
WEBAUTHN (BIOMETRIC UNLOCK)
*/
if(req.method==="GET"&&path==="/api/webauthn/credentials"){
const r=await db(`SELECT id,device_label,created_at,last_used_at FROM webauthn_credentials WHERE user_id=$1 ORDER BY created_at DESC`,[user.user_id]);
return send(res,200,{success:true,credentials:r.rows});
}
if(req.method==="POST"&&path==="/api/webauthn/credentials/remove"){
const rl=rateLimit(req,`webauthn-remove:${user.user_id}`,10,15*60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=await body(req);
const id=Number(b.id);
if(!(id>0))return send(res,400,{success:false,message:"A credential id is required."});
const r=await db(`DELETE FROM webauthn_credentials WHERE id=$1 AND user_id=$2 RETURNING id`,[id,user.user_id]);
if(!r.rows.length)return send(res,404,{success:false,message:"Credential not found."});
try{await addNotification(user.user_id,"Biometric unlock removed","A biometric credential was removed from your BOLTIV account.","security");}catch{}
return send(res,200,{success:true});
}
if(req.method==="POST"&&path==="/api/webauthn/register/options"){
const rl=rateLimit(req,`webauthn-register-options:${user.user_id}`,10,15*60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const result=await webauthnRegistrationOptions(user);
return send(res,result.success?200:(result.statusCode||400),result);
}
if(req.method==="POST"&&path==="/api/webauthn/register/verify"){
const rl=rateLimit(req,`webauthn-register-verify:${user.user_id}`,10,15*60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=await body(req);
const result=await webauthnRegistrationVerify(user,b.credential,b.deviceLabel);
return send(res,result.success?200:(result.statusCode||400),result);
}
if(req.method==="POST"&&path==="/api/webauthn/authenticate/options"){
const rl=rateLimit(req,`webauthn-auth-options:${user.user_id}`,20,15*60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const result=await webauthnAuthenticationOptions(user);
return send(res,result.success?200:(result.statusCode||400),result);
}
if(req.method==="POST"&&path==="/api/webauthn/authenticate/verify"){
const rl=rateLimit(req,`webauthn-auth-verify:${user.user_id}`,20,15*60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const b=await body(req);
const result=await webauthnAuthenticationVerify(user,b.credential);
return send(res,result.success?200:(result.statusCode||400),result);
}
if(req.method==="GET"&&path==="/api/transactions/detail"){
const ref=clean(url.searchParams.get("reference")); const r=await db(`SELECT * FROM transactions WHERE user_id=$1 AND reference=$2 LIMIT 1`,[user.user_id,ref]); if(!r.rows.length)return send(res,404,{success:false,message:"Transaction not found."}); const t=r.rows[0];
let meta=t.metadata; if(typeof meta==="string"){try{meta=JSON.parse(meta)}catch{meta={}}} meta=meta&&typeof meta==="object"?meta:{};
const requestMeta=meta.request&&typeof meta.request==="object"?meta.request:{};
const pricing=meta.pricing&&typeof meta.pricing==="object"?meta.pricing:{};
const enrichedMeta={...meta};
if(!enrichedMeta.network)enrichedMeta.network=pricing.network||pricing.network_name||requestMeta.network||requestMeta.network_provider||"";
if(!enrichedMeta.plan)enrichedMeta.plan=pricing.plan||requestMeta.plan_name||requestMeta.plan||"";
if(String(t.service).toLowerCase().includes("data") && (/^Plan \d+$/i.test(String(enrichedMeta.plan||"")) || !enrichedMeta.plan)){
  const resolved=await resolveDataPlanName(enrichedMeta.network||requestMeta.network||requestMeta.network_provider,requestMeta.bundle_id||enrichedMeta.bundle_id);
  if(resolved)enrichedMeta.plan=resolved;
}
if(!enrichedMeta.phone)enrichedMeta.phone=t.recipient||requestMeta.phone||requestMeta.phone_number||"";
return send(res,200,{success:true,transaction:{...t,metadata:enrichedMeta,amount:Number(t.amount)}});
}
if(req.method==="GET"&&path==="/api/notifications"){
// Backfill transaction notifications for successful purchases that may have
// completed before notification creation, or where a previous notification
// insert failed. This makes the notifications page self-healing.
try{
  // Backfill from the transactions table itself. Older successful purchases may
  // have been recorded before notification creation was added, and some legacy
  // rows do not use type='debit'. The service name is the safer discriminator.
  const recent=await db(`
    SELECT id,user_id,type,service,amount,status,date,metadata
    FROM transactions
    WHERE user_id=$1
      AND status='successful'
      AND date>NOW()-INTERVAL '30 days'
      AND LOWER(COALESCE(service,'')) <> 'wallet funding'
    ORDER BY date DESC
    LIMIT 100
  `,[user.user_id]);
  for(const tx of recent.rows){
    const meta=tx.metadata&&typeof tx.metadata==="object"?tx.metadata:{};
    let message=`Your ${String(tx.service||"service")} purchase of ₦${Number(tx.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
    if(String(tx.service).toLowerCase().includes("data")){
      const pricing=meta.pricing&&typeof meta.pricing==="object"?meta.pricing:{};
      const network=clean(meta.network||meta.network_provider||pricing.network||pricing.network_name||meta.request?.network||meta.request?.network_provider||"");
      let plan=clean(meta.plan||meta.plan_name||pricing.plan||pricing.plan_name||meta.request?.plan_name||meta.request?.plan||"");
      if(/^Plan \d+$/i.test(plan)||!plan)plan=await resolveDataPlanName(network||meta.request?.network||meta.request?.network_provider,meta.request?.bundle_id||meta.bundle_id||pricing.bundle_id);
      if(network||plan)message=`Your ${network||"Data"} ${plan||"data plan"} purchase of ₦${Number(tx.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
    }
    try{
      await addNotificationOnce(user.user_id,"Transaction successful",message,"transaction",`tx-success-${tx.id}`);
    }catch(error){
      console.error("NOTIFICATION BACKFILL ITEM ERROR:",error?.stack||error?.message||error);
    }
  }

  // Also backfill wallet-funding notifications for older deposits.
  const funding=await db(`
    SELECT id,user_id,amount,date,provider_reference
    FROM transactions
    WHERE user_id=$1
      AND status='successful'
      AND LOWER(COALESCE(service,''))='wallet funding'
      AND date>NOW()-INTERVAL '30 days'
    ORDER BY date DESC
    LIMIT 100
  `,[user.user_id]);
  for(const tx of funding.rows){
    const amount=Number(tx.amount);
    const message=`Your wallet was credited with ₦${amount.toLocaleString("en-NG",{minimumFractionDigits:2})} via Flutterwave bank transfer.`;
    await addNotificationOnce(user.user_id,"Wallet credited",message,"payment",`wallet-fund-${tx.id}`);
  }
}catch(error){console.error("NOTIFICATION BACKFILL ERROR:",error?.stack||error?.message||error);}
const r=await db(`SELECT id,title,message,type,read,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,[user.user_id]);
const unread=r.rows.filter(n=>!n.read).length;
return send(res,200,{success:true,notifications:r.rows,unreadCount:unread});
}
if(req.method==="POST"&&path==="/api/notifications/read"){
const b=await body(req); if(b.id) await db(`UPDATE notifications SET read=TRUE WHERE id=$1 AND user_id=$2`,[b.id,user.user_id]); else await db(`UPDATE notifications SET read=TRUE WHERE user_id=$1`,[user.user_id]); return send(res,200,{success:true});
}
if(req.method==="POST"&&path==="/api/profile/update"){
const b=await body(req); const name=clean(b.name),phone=clean(b.phone),email=clean(b.email).toLowerCase();
if(name.length<2)return send(res,400,{success:false,message:"Please enter your full name."});
if(phone && !/^[0-9+()\-\s]{10,20}$/.test(phone))return send(res,400,{success:false,message:"Please enter a valid phone number."});
if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{success:false,message:"Please enter a valid email address."});
try{
const r=await db(`UPDATE users SET name=$1,phone=$2,email=$3,updated_at=NOW() WHERE user_id=$4 RETURNING user_id,name,phone,email,status,created_at`,[name,phone,email,user.user_id]);
if(!r.rows.length)return send(res,404,{success:false,message:"User account not found."});
return send(res,200,{success:true,user:r.rows[0],message:"Profile updated successfully."});
}catch(e){if(e.code==="23505")return send(res,409,{success:false,message:"That email address is already in use."}); throw e;}
}
if(req.method==="POST"&&path==="/api/support/tickets"){
const b=await body(req); const subject=clean(b.subject),message=clean(b.message),transactionReference=clean(b.transactionReference||b.reference); if(subject.length<3||message.length<5)return send(res,400,{success:false,message:"Please provide a subject and more details."});
const client=await pool.connect();
try{
await client.query("BEGIN");
const r=await client.query(`INSERT INTO support_tickets(user_id,subject,message,transaction_reference) VALUES($1,$2,$3,$4) RETURNING id,subject,message,status,transaction_reference,created_at`,[user.user_id,subject,message,transactionReference||null]);
await client.query(`INSERT INTO support_messages(ticket_id,sender_type,sender_id,message) VALUES($1,'user',$2,$3)`,[r.rows[0].id,user.user_id,message]);
await client.query("COMMIT");
try{await addNotification(user.user_id,"Support request received",`Your support ticket #${r.rows[0].id} has been created. We will review it shortly.`,"support");}catch{}
return send(res,201,{success:true,ticket:r.rows[0],message:`Support ticket #${r.rows[0].id} created.`});
}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}
if(req.method==="GET"&&path==="/api/support/tickets"){
const r=await db(`SELECT id,subject,message,status,transaction_reference,created_at,updated_at FROM support_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,[user.user_id]); return send(res,200,{success:true,tickets:r.rows});
}
if(req.method==="GET"&&path==="/api/support/ticket"){
const id=Number(url.searchParams.get("id")); if(!Number.isInteger(id)||id<1)return send(res,400,{success:false,message:"Invalid ticket."});
const t=await db(`SELECT id,subject,message,status,transaction_reference,created_at,updated_at FROM support_tickets WHERE id=$1 AND user_id=$2 LIMIT 1`,[id,user.user_id]);
if(!t.rows.length)return send(res,404,{success:false,message:"Support ticket not found."});
const m=await db(`SELECT id,sender_type,message,created_at FROM support_messages WHERE ticket_id=$1 ORDER BY created_at ASC`,[id]);
return send(res,200,{success:true,ticket:t.rows[0],messages:m.rows});
}
if(req.method==="POST"&&path==="/api/support/ticket/reply"){
const b=await body(req); const id=Number(b.id),message=clean(b.message);
if(!Number.isInteger(id)||id<1||message.length<2)return send(res,400,{success:false,message:"Please enter a message."});
const t=await db(`SELECT id,status FROM support_tickets WHERE id=$1 AND user_id=$2 LIMIT 1`,[id,user.user_id]);
if(!t.rows.length)return send(res,404,{success:false,message:"Support ticket not found."});
if(t.rows[0].status==="closed")return send(res,400,{success:false,message:"This ticket is closed. Please create a new ticket."});
await db(`INSERT INTO support_messages(ticket_id,sender_type,sender_id,message) VALUES($1,'user',$2,$3)`,[id,user.user_id,message]);
await db(`UPDATE support_tickets SET status='open',updated_at=NOW() WHERE id=$1`,[id]);
return send(res,200,{success:true,message:"Reply sent."});
}
return null;
}

async function handleUserRoutes(
req,
res,
path,
url
){

/*
CURRENT USER
*/

if(
req.method==="GET"&&
path==="/api/me"
){

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

await createWallet(user.user_id);
const wallet=await getWallet(user.user_id);

return send(res,200,{
success:true,
user:{
id:user.user_id,
userId:user.user_id,
name:user.name||"",
phone:user.phone||"",
email:user.email
},
wallet
});

}


/*
WALLET
*/

if(req.method==="POST"&&path==="/api/wallet/create"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
await createWallet(user.user_id);
const wallet=await getWallet(user.user_id);
return send(res,200,{success:true,wallet});
}

if(
req.method==="GET"&&
path==="/api/wallet"
){

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

await createWallet(
user.user_id
);

const wallet=
await getWallet(
user.user_id
);

return send(res,200,{
success:true,
wallet
});

}


/*
TRANSACTIONS
*/

if(
req.method==="GET"&&
path==="/api/transactions"
){

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const transactions=
await getTransactions(
user.user_id
);

return send(res,200,{
success:true,
transactions
});

}


/*
WALLET HISTORY SUMMARY
*/

if(
req.method==="GET"&&
path==="/api/wallet/summary"
){

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const summary=
await getWalletSummary(
user.user_id
);

return send(res,200,{
success:true,
summary
});

}


/*
PAYMENT INITIALIZATION
*/


/*
FLUTTERWAVE VIRTUAL ACCOUNT FUNDING
*/

if(req.method==="GET"&&path==="/api/funding-account"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
try{const result=await getFlutterwaveStaticFundingAccount(user);return send(res,200,result);}catch(error){console.error("FLUTTERWAVE ACCOUNT LOOKUP ERROR:",error);return send(res,502,{success:false,message:error.message||"Unable to load funding account."});}
}

if(req.method==="POST"&&path==="/api/funding-account/activate"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
try{const b=await body(req),accountType=String(b.accountType||"static").toLowerCase();let result;if(accountType==="dynamic")result=await createCustomerFlutterwaveDynamicAccount(user,Number(b.amount));else result=await createCustomerFlutterwaveStaticAccount(user,String(b.identityType||"").toLowerCase(),String(b.identityNumber||""));return send(res,200,result);}catch(error){console.error("FLUTTERWAVE FUNDING ACCOUNT ACTIVATION ERROR:",error);return send(res,400,{success:false,message:error.message||"Unable to create funding account."});}
}

if(req.method==="POST"&&path==="/api/flutterwave/webhook"){
let rawBody="";req.on("data",chunk=>{rawBody+=chunk;});req.on("end",async()=>{
try{
const directSignature=String(req.headers["verif-hash"]||"");
const hmacSignature=String(req.headers["flutterwave-signature"]||"");
let valid=false;
if(FLW_SECRET_HASH){
if(directSignature&&directSignature===FLW_SECRET_HASH)valid=true;
if(hmacSignature){
const expected=crypto.createHmac("sha256",FLW_SECRET_HASH).update(rawBody).digest("base64");
const supplied=Buffer.from(hmacSignature,"utf8");
const expectedBuf=Buffer.from(expected,"utf8");
if(supplied.length===expectedBuf.length && crypto.timingSafeEqual(supplied,expectedBuf))valid=true;
}
}
if(!valid)return send(res,401,{success:false,message:"Invalid Flutterwave webhook signature."});
let payload;try{payload=JSON.parse(rawBody||"{}");}catch{return send(res,400,{success:false,message:"Invalid JSON payload."});}
const event=String(payload?.event||payload?.type||payload?.event_type||"").toLowerCase();
if(event==="charge.completed"||event==="account_transaction"||event==="bank_transfer_transaction"||payload?.["event.type"]==="BANK_TRANSFER_TRANSACTION"){
const result=await creditFlutterwaveVirtualAccount(payload);return send(res,200,{success:true,message:result.duplicate?"Webhook already processed.":"Flutterwave funding webhook processed.",...result});
}
return send(res,200,{success:true,message:"Flutterwave webhook received."});
}catch(error){console.error("FLUTTERWAVE WEBHOOK ERROR:",error);return send(res,500,{success:false,message:error.message||"Webhook processing failed."});}
});return;
}

if(
req.method==="POST"&&
path==="/api/payments/initialize"
){

const rl=rateLimit(req,"payment-initialize",10,60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const b=
await body(req);

const amount=
Number(b.amount);

if(!validAmount(amount)){

return send(res,400,{
success:false,
message:
"Invalid payment amount."
});

}

return send(res,410,{
success:false,
message:"Wallet funding is handled through Flutterwave virtual accounts."
});

}


/*
PAYMENT VERIFICATION
*/

if(
req.method==="GET"&&
path==="/api/payments/verify"
){

const rl=rateLimit(req,"payment-verify",20,60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);

const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});

const referenceValue=
clean(
url.searchParams.get(
"reference"
)
);

if(!referenceValue){

return send(res,400,{
success:false,
message:
"Payment reference is required."
});

}

return send(res,410,{
success:false,
message:"Wallet funding is handled through Flutterwave virtual accounts."
});

}


/*
VTU DATA PLAN CATALOG
*/

if(req.method==="POST"&&path==="/api/vtu/data/plans"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
const b=await body(req);
const network=normalizeDataNetwork(b.network);
if(!network)return send(res,400,{success:false,message:"Unsupported network."});
try{
let cacheEntry=vtugatePlanCache.get(network);
if(!cacheEntry||Date.now()-cacheEntry.at>60000){cacheEntry={at:Date.now(),plans:await fetchVTUGATEDataPlans(network)};vtugatePlanCache.set(network,cacheEntry);}
const rawPlans=cacheEntry.plans;
const service=await getService("data");
if(!service)return send(res,503,{success:false,message:"Data service is not configured."});
if(service.enabled===false)return send(res,503,{success:false,message:"Data service is currently unavailable."});
if(service.maintenance===true)return send(res,503,{success:false,message:"Data service is currently under maintenance."});
const pricing=pricingConfig(service);
const byPlan=new Map();
for(const plan of rawPlans){
const planCode=clean(plan.plan_code||plan.code||""), providerPrice=Number(plan.price||0), planServiceId=Number(plan.service_id||0);
if(!planCode||!Number.isFinite(providerPrice)||providerPrice<=0)continue;
const customerPrice=customerPriceFromCost(providerPrice,pricing);
if(customerPrice===null)continue;
const lookupKey=planLookupKey(planCode,planServiceId);
byPlan.set(lookupKey,{code:planCode,plan_code:planCode,provider_code:planCode,lookup_key:lookupKey,bundle_id:lookupKey,name:clean(plan.name||planCode),customer_price:customerPrice,provider_price:Number(providerPrice.toFixed(2)),network_name:network,sales_channel:clean(plan.sales_channel||''),service_id:planServiceId,size_mb:Number(plan.size_mb||0),validity_days:Number(plan.validity_days||0),validity:clean(plan.validity||plan.validity_period||plan.duration||"") ,validity_period:clean(plan.validity_period||plan.validity||plan.duration||"") ,duration:clean(plan.duration||plan.validity||plan.validity_period||"")});
}
const plans=Array.from(byPlan.values())
.filter(plan=>['SME','Gifting'].includes(plan.sales_channel)&&Number(plan.size_mb||0)>=500)
.sort((a,b)=>Number(a.customer_price)-Number(b.customer_price)).slice(0,50);
return send(res,200,{success:true,network,plans});
}catch(error){console.error("VTUGATE DATA PLAN CATALOG ERROR:",error?.stack||error?.message||error);return send(res,502,{success:false,message:"Unable to load VTUGATE data plans right now."});}
}

/*
EDUCATION PIN CATALOG

VTUGATE exposes current education pricing through geteducationtypeprice.
The BOLTIV UI already supports a product selector, so we return the configured
education product codes with their live per-pin price. Product codes can be
customized with VTUGATE_EDUCATION_PRODUCTS.
*/

if(req.method==="GET"&&path==="/api/vtu/exam-pin/products"){
const user=await userFromToken(req);if(!user)return send(res,401,{success:false,message:"Unauthorized."});
try{
const service=await getService("exam_pin");if(!service)return send(res,503,{success:false,message:"Exam PIN service is not configured."});if(service.enabled===false)return send(res,503,{success:false,message:"Exam PIN service is currently unavailable."});if(service.maintenance===true)return send(res,503,{success:false,message:"Exam PIN service is currently under maintenance."});
const baseProducts=await getVTUGATEEducationProducts();const pricing=pricingConfig(service);const products=[];for(const product of baseProducts){try{const price=await getVTUGATEEducationPrice(product.service_id);const customerPrice=customerPriceFromCost(price,pricing);if(price>0&&customerPrice>0)products.push({...product,provider_price:price,customer_price:customerPrice});}catch{}}
return send(res,200,{success:true,products});
}catch(error){console.error("VTUGATE EDUCATION CATALOG ERROR:",error?.stack||error?.message||error);return send(res,502,{success:false,message:error.message||"Unable to load education PIN products right now."});}
}

if(req.method==="POST"&&path==="/api/vtu/cable/verify"){const user=await userFromToken(req);if(!user)return send(res,401,{success:false,message:"Unauthorized."});const r=await verifyVTUGATECable(req);return send(res,r.success?200:(r.statusCode||400),r);}
if(req.method==="POST"&&path==="/api/vtu/electricity/verify"){const user=await userFromToken(req);if(!user)return send(res,401,{success:false,message:"Unauthorized."});const r=await verifyVTUGATEElectricity(req);return send(res,r.success?200:(r.statusCode||400),r);}

/*
VTU TRANSACTION
*/

if(
req.method==="POST"&&
["/api/vtu/purchase","/api/vtu/airtime","/api/vtu/data","/api/vtu/cable","/api/vtu/electricity","/api/vtu/exam-pin"].includes(path)
){

const rl=rateLimit(req,"vtu-transaction",30,60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);

const user=
await userFromToken(req);

if(!user){

return send(res,401,{
success:false,
message:
"Unauthorized."
});

}

const b=await body(req);
// path.split("/").pop() yields "exam-pin" (hyphen) for the /api/vtu/exam-pin route,
// but processVTUTransaction's service whitelist uses "exam_pin" (underscore) — without
// this normalization, any caller that omits `service` from the body (the generic
// /api/vtu/purchase route, or a future client) would always get rejected with
// "This service is not currently wired to VTUGATE." for exam PIN purchases.
if(!b.service){b.service=path.split("/").pop().replace(/-/g,"_");}
if(!b.providerPayload){b.providerPayload={...b,service:b.service};}
const result=await processVTUTransaction(user,b);

return send(
res,
result.success?
200:
(result.statusCode||400),
result
);

}

return null;

  }
const server=http.createServer(
async(req,res)=>{

if(req.method==="OPTIONS"){

res.writeHead(204,{
"Access-Control-Allow-Origin":corsOrigin(req),
"Vary":"Origin",
"Access-Control-Allow-Methods":
"GET,POST,PATCH,OPTIONS",
"Access-Control-Allow-Headers":
"Content-Type,Authorization,X-Idempotency-Key,X-Admin-CSRF",
"Access-Control-Allow-Credentials":"true"
});

return res.end();

}

try{

res.__corsOrigin=corsOrigin(req);

const url=
new URL(
req.url,
`http://${req.headers.host||"localhost"}`
);

const path=
url.pathname;


/*
HEALTH CHECK
*/

if(
req.method==="GET"&&
path==="/"
){

return send(res,200,{
success:true,
message:
"BOLTIV API is running.",
status:
"online"
});

}


/*
API HEALTH CHECK
*/

if(
req.method==="GET"&&
path==="/api/health"
){
  // Public health check: expose only customer-facing service states.
  // Never expose provider names, database state, API configuration, or secrets.
  const services={
    platform:"online",
    airtimeData:"online",
    paymentsWallet:"online",
    transactions:"online"
  };

  let databaseOk=true;
  try{
    if(!DATABASE_URL) databaseOk=false;
    else await db("SELECT 1");
  }catch(error){
    databaseOk=false;
  }

  if(!databaseOk){
    services.platform="degraded";
    services.airtimeData="degraded";
    services.paymentsWallet="degraded";
    services.transactions="degraded";
  }else{
    try{
      const [airtime,data]=await Promise.all([getService("airtime"),getService("data")]);
      if((airtime&&(airtime.enabled===false||airtime.maintenance===true))||
         (data&&(data.enabled===false||data.maintenance===true))){
        services.airtimeData="degraded";
      }
    }catch(error){
      services.airtimeData="degraded";
    }

    // Server-side provider check; only the public service state is returned.
    // Uses fetchallservices (all=true) — the same endpoint the rest of the
    // app relies on for real service-ID resolution and purchases — so this
    // check reflects the provider path actually used, instead of the
    // separate/unused fetchservices endpoint which was causing false
    // "degraded" readings.
    try{
      const provider=await fetchVTUGATEServices(true);
      if(!provider.success) services.airtimeData="degraded";
    }catch(error){
      services.airtimeData="degraded";
    }
  }

  const status=Object.values(services).includes("degraded")?"degraded":"online";
  return send(res,status==="online"?200:503,{
    success:true,
    message:status==="online"?"BOLTIV is operational.":"Some BOLTIV services may be limited.",
    status,
    services,
    timestamp:new Date().toISOString()
  });
}


/*
ADMIN ROUTES
*/

const adminHandled=
await handleAdminRoutes(
req,
res,
path
);

if(adminHandled){

return;
}


/*
PASSWORD RESET ROUTES
*/

const passwordHandled=
await handlePasswordRoutes(
req,
res,
path
);

if(passwordHandled){

return;
}


/*
PUBLIC PLATFORM CONFIGURATION
*/
if(req.method==='GET'&&path==='/api/pricing'){
  const keys=['airtime','data','cable','electricity','exam_pin'];
  const out={};
  for(const key of keys){const svc=await getService(key);const p=pricingConfig(svc);out[key]={available:Boolean(svc&&svc.enabled!==false&&svc.maintenance!==true)};}
  return send(res,200,{success:true,pricing:out});
}

if(req.method==='GET'&&path==='/api/services'){const r=await db(`SELECT key,name,icon,enabled,maintenance FROM services WHERE key IN ('airtime','data','electricity','cable','exam_pin') ORDER BY key`);return send(res,200,{success:true,services:r.rows.map(x=>({...x,available:x.enabled!==false&&x.maintenance!==true}))});}
if(req.method==='GET'&&path==='/api/platform/settings'){const fallback=[{text:'Welcome to BOLTIV — Fast. Simple. Powerful.',enabled:true}]; let items=await getPlatformSetting('announcement_items',fallback); if(!Array.isArray(items))items=fallback; items=items.filter(x=>x&&x.text&&x.enabled!==false).slice(0,10); return send(res,200,{success:true,settings:{maintenance_mode:Boolean(await getPlatformSetting('maintenance_mode',false)),registration_enabled:Boolean(await getPlatformSetting('registration_enabled',true)),announcement_enabled:Boolean(await getPlatformSetting('announcement_enabled',true)),announcement_text:String(await getPlatformSetting('announcement_text',items[0]?.text||fallback[0].text)),announcement_items:items}});}

/*
AUTH ROUTES
*/

const authHandled=
await handleAuthRoutes(
req,
res,
path,
url
);

if(authHandled){

return;
}


/*
USER ROUTES
*/

const extraHandled=await handleExtraUserRoutes(req,res,path,url);

if(extraHandled){return;}

const userHandled=
await handleUserRoutes(
req,
res,
path,
url
);

if(userHandled){

return;
}


/*
UNKNOWN ROUTE
*/

return send(res,404,{
success:false,
message:
"Route not found."
});

}catch(error){

console.error(
"SERVER ERROR:",
error
);

return send(res,500,{
success:false,
message:
"Internal server error"
});

}

});
async function startServer(){

try{

await setup();
setTimeout(()=>runPlatformAlerts().catch(e=>console.error("INITIAL ALERT CHECK ERROR",e)),5000).unref();
setInterval(()=>runPlatformAlerts().catch(e=>console.error("ALERT CHECK ERROR",e)),300000).unref();

await cleanupPasswordResetTokens();
cleanupTransactionPinResetTokens();

/*
Clean expired reset tokens every hour.
*/

setInterval(
()=>{
cleanupPasswordResetTokens();
},
60*60*1000
);

server.listen(
PORT,
"0.0.0.0",
()=>{

console.log(
`BOLTIV API running on port ${PORT}`
);

console.log(
`Frontend: ${FRONTEND_URL}`
);

// Reconcile provider-pending transactions every 5 minutes.
const reconcileIntervalMs=Math.max(30000,Number(process.env.PENDING_RECONCILE_INTERVAL_MS||300000));
setTimeout(()=>reconcileVTUGATETransactions().catch(error=>console.error("INITIAL VTUGATE RECONCILIATION ERROR:",error)),15000).unref();
setInterval(()=>{
  reconcileVTUGATETransactions().catch(error=>console.error("AUTOMATIC VTUGATE RECONCILIATION ERROR:",error));
},reconcileIntervalMs).unref();

console.log(
`Admin configured: ${
ADMIN_EMAIL?
"YES":
"NO"
}`
);

console.log(
`Flutterwave configured: ${
FLW_SECRET_KEY?
"YES":
"NO"
}`
);

console.log(
`VTU configured: ${
VTUGATE_API_KEY&&VTUGATE_API_BASE_URL?
"YES":
"NO"
}`
);

console.log(
`Password reset email configured: ${
RESEND_API_KEY?
"YES":
"NO"
}`
);

}
);

}catch(error){

console.error(
"STARTUP ERROR:",
error?.stack||error?.message||error
);

process.exit(1);

}

}


process.on(
"SIGTERM",
async()=>{

console.log(
"SIGTERM received. Shutting down..."
);

server.close(
async()=>{

try{

await pool.end();

console.log(
"BOLTIV server stopped."
);

process.exit(0);

}catch(error){

console.error(
"SHUTDOWN ERROR:",
error
);

process.exit(1);

}

}
);

});


process.on(
"SIGINT",
async()=>{

console.log(
"SIGINT received. Shutting down..."
);

server.close(
async()=>{

try{

await pool.end();

console.log(
"BOLTIV server stopped."
);

process.exit(0);

}catch(error){

console.error(
"SHUTDOWN ERROR:",
error
);

process.exit(1);

}

}
);

});


startServer();

