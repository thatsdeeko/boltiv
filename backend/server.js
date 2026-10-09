const http=require("node:http");
const crypto=require("node:crypto");
const zlib=require("node:zlib");
const {Pool}=require("pg");

const PORT=process.env.PORT||3000;
const DATABASE_URL=process.env.DATABASE_URL||"";
const BACKEND_PUBLIC_URL=(process.env.BACKEND_PUBLIC_URL||"").replace(/\/+$/,"");

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
ssl:DATABASE_URL?{rejectUnauthorized:false}:false,
max:Number(process.env.DB_POOL_MAX||10),
idleTimeoutMillis:30000,
connectionTimeoutMillis:5000
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
// Gzip larger JSON responses (e.g. data plan lists) when the browser supports it.
let body=JSON.stringify(data);
let payload=body;
const extraHeaders={};
try{
const ae=String(res.req?.headers?.["accept-encoding"]||"");
if(/\bgzip\b/i.test(ae)&&body.length>1024&&body.length<5*1024*1024){
payload=zlib.gzipSync(body,{level:4});
extraHeaders["Content-Encoding"]="gzip";
}
}catch{payload=body;delete extraHeaders["Content-Encoding"];}
res.writeHead(status,{
...extraHeaders,
"Content-Type":"application/json",
"Access-Control-Allow-Origin":res.__corsOrigin||DEFAULT_FRONTEND_ORIGIN,
"Vary":"Origin, Accept-Encoding",
"Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS",
"Access-Control-Allow-Headers":"Content-Type,Authorization,X-Idempotency-Key,X-Admin-CSRF",
"Access-Control-Allow-Credentials":"true",
"X-Content-Type-Options":"nosniff",
"X-Frame-Options":"DENY",
"Referrer-Policy":"strict-origin-when-cross-origin",
"Cache-Control":"no-store"
});
res.end(payload);
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

// Minimum electricity purchase (₦). Enforced server-side in processVTUTransaction and shown on electricity.html.
const MIN_ELECTRICITY_AMOUNT=2000;

// Pulls the meter/token details of an electricity transaction out of its stored metadata so the
// history/receipt screens can show them. Works for old rows too: the request (meter_no, disco) and the
// full VTUGATE response are already saved in transactions.metadata at purchase time.
function electricityDetailsFromMetadata(meta){
  meta=meta&&typeof meta==="object"?meta:{};
  const req=meta.request&&typeof meta.request==="object"?meta.request:{};
  const pricing=meta.pricing&&typeof meta.pricing==="object"?meta.pricing:{};
  const resp=meta.provider_response&&typeof meta.provider_response==="object"?meta.provider_response:{};
  const delivery=resp?.data?.delivery||resp?.delivery||null;
  const token=meta.token||findTransactionField(resp,["token","meter_token","recharge_token","standard_token","units_token","electricity_token","vend_token"])||(delivery&&delivery.token)||"";
  const units=meta.units||findTransactionField(resp,["units","kwh","unit"])||"";
  return {
    disco:clean(pricing.network||req.disco||""),
    meterNumber:clean(meta.meterNumber||req.meter_no||""),
    meterType:clean(meta.meterType||pricing.plan||""),
    token:clean(token),
    units:clean(units)
  };
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
  // Percentage-based pricing only — "fixed profit per sale" has been removed. Whatever mode
  // is stored, always resolve to markup_percentage so a stale record or a direct API call
  // can't put a service back on flat fixed-amount pricing.
  const discountPct=Number(adminPricing.discount_pct??adminPricing.discountPercent??0);
  const serviceFee=Number(service?.fee||0);
  return {markup_mode:"markup_percentage",markup_pct:Number.isFinite(discountPct)?Math.min(500,Math.max(0,discountPct)):0,markup_fixed:0,service_fee:Number.isFinite(serviceFee)?Math.max(0,serviceFee):0};
}
let mode=clean(config.markup_mode??config.markupMode??config.pricing_mode??config.pricingMode??"none").toLowerCase();
if(mode==="percent")mode="percentage"; if(mode==="fixed_amount")mode="fixed"; if(mode==="cost_plus")mode="percentage_plus_fixed";
const pct=Number(config.markup_pct??config.markupPercent??config.percentage??0);
const fixed=Number(config.markup_fixed??config.markupFixed??config.fixed??service?.fee??0);
return {markup_mode:["none","percentage","fixed","percentage_plus_fixed"].includes(mode)?mode:"none",markup_pct:Number.isFinite(pct)?Math.max(0,pct):0,markup_fixed:Number.isFinite(fixed)?Math.max(0,fixed):0,service_fee:0};
}

function customerPriceFromCost(cost,pricing){
const n=Number(cost); if(!Number.isFinite(n)||n<=0)return null; const p=pricing||{}; let price=n;
if(p.markup_mode==="markup_percentage"){price=n*(1+Number(p.markup_pct||0)/100)+Number(p.markup_fixed||0)+Number(p.service_fee||0);}
else if(p.markup_mode==="fixed_profit"){price=n+Number(p.markup_fixed||0)+Number(p.service_fee||0);}
else if(p.markup_mode==="fixed")price+=Number(p.markup_fixed||0);
else if(p.markup_mode==="percentage")price+=n*Number(p.markup_pct||0)/100;
else if(p.markup_mode==="percentage_plus_fixed")price+=n*Number(p.markup_pct||0)/100+Number(p.markup_fixed||0);
return Number(price.toFixed(2));
}

// BOLTIV Agent wholesale pricing — GLOBAL, one configuration per service, read from the
// dedicated agent_pricing table (see getAgentPricingRow/getAllAgentPricing below). Deliberately
// separate from pricingConfig() (the B2C customer price): this is normally a lower markup than
// the B2C one, which is what makes the Agent price "wholesale". overridePct is the ONLY thing
// that may vary per agent (an individually negotiated rate) — the fixed fee and active flag are
// always the single global value, exactly as requested: no separate pricing records per agent.
function agentPricingConfig(pricingRow,overridePct){
  const row=pricingRow||{};
  const defaultPct=Number(row.markup_percent??0);
  const pct=Number.isFinite(overridePct)?overridePct:(Number.isFinite(defaultPct)?defaultPct:0);
  const fixedFee=Number(row.fixed_fee??0);
  return {markup_mode:"markup_percentage",markup_pct:Math.min(500,Math.max(0,pct)),markup_fixed:Number.isFinite(fixedFee)?Math.max(0,fixedFee):0,service_fee:0};
}
async function getAgentPricingRow(serviceKey){
  const key=clean(serviceKey);
  const r=await db(`SELECT service,markup_percent,fixed_fee,active,updated_at FROM agent_pricing WHERE service=$1 LIMIT 1`,[key]);
  if(r.rows.length)return r.rows[0];
  // Auto-provision a default row the first time a service is priced for Agents — this is what
  // keeps the architecture extensible to services added later without any manual setup step.
  await db(`INSERT INTO agent_pricing(service,markup_percent,fixed_fee,active) VALUES($1,0,0,true) ON CONFLICT(service) DO NOTHING`,[key]);
  const retry=await db(`SELECT service,markup_percent,fixed_fee,active,updated_at FROM agent_pricing WHERE service=$1 LIMIT 1`,[key]);
  return retry.rows[0]||{service:key,markup_percent:0,fixed_fee:0,active:true,updated_at:null};
}
async function getAllAgentPricing(){
  for(const key of ['airtime','data','electricity','cable'])await getAgentPricingRow(key);
  const r=await db(`SELECT ap.service,ap.markup_percent,ap.fixed_fee,ap.active,ap.updated_at,s.name,s.icon,s.enabled AS platform_enabled,s.maintenance FROM agent_pricing ap LEFT JOIN services s ON s.key=ap.service ORDER BY ap.service`);
  return r.rows.map(x=>({service:x.service,name:x.name||x.service,icon:x.icon||'⚙',markupPercent:Number(x.markup_percent||0),fixedFee:Number(x.fixed_fee||0),active:Boolean(x.active),platformEnabled:Boolean(x.platform_enabled),maintenance:Boolean(x.maintenance),updatedAt:x.updated_at}));
}

const DEFAULT_AGENT_LIMITS={minWalletBalance:10000,maxTransaction:50000,dailyLimit:500000,dailyCount:100};
async function getAgentLimits(agentProfile){
  let global=DEFAULT_AGENT_LIMITS;
  try{const r=await db(`SELECT value FROM platform_settings WHERE key='agent_limits' LIMIT 1`);if(r.rows.length)global={...DEFAULT_AGENT_LIMITS,...r.rows[0].value};}catch{}
  return {
    minWalletBalance:Number(global.minWalletBalance??DEFAULT_AGENT_LIMITS.minWalletBalance),
    maxTransaction:agentProfile?.max_transaction_override!=null?Number(agentProfile.max_transaction_override):Number(global.maxTransaction??DEFAULT_AGENT_LIMITS.maxTransaction),
    dailyLimit:agentProfile?.daily_limit_override!=null?Number(agentProfile.daily_limit_override):Number(global.dailyLimit??DEFAULT_AGENT_LIMITS.dailyLimit),
    dailyCount:agentProfile?.daily_count_override!=null?Number(agentProfile.daily_count_override):Number(global.dailyCount??DEFAULT_AGENT_LIMITS.dailyCount)
  };
}
// Enforced right before an Agent transaction is committed. All figures are checked against the
// Agent's own wallet-debit amount (the wholesale price BOLTIV actually charges the Agent), since
// that's the value that reflects real platform risk — not whatever the Agent tells their own
// customer they're charging.
async function checkAgentLimits(userId,agentProfile,thisTransactionAmount){
  const limits=await getAgentLimits(agentProfile);
  if(thisTransactionAmount>limits.maxTransaction)return{ok:false,message:`This transaction (₦${thisTransactionAmount.toLocaleString('en-NG',{minimumFractionDigits:2})}) exceeds your maximum per-transaction limit of ₦${limits.maxTransaction.toLocaleString('en-NG',{minimumFractionDigits:2})}.`};
  // NOTE: There is intentionally NO minimum-balance check here. The ₦10,000 figure
  // (limits.minWalletBalance) is only the Agent ACTIVATION requirement, enforced in
  // activateAgentForUser(). Once active, an Agent may spend any available wallet balance;
  // insufficient funds are rejected atomically by createVTUTransactionAndDebit
  // (UPDATE ... WHERE balance>=amount).
  const r=await db(`SELECT COALESCE(SUM(amount),0) AS total,COUNT(*)::int AS cnt FROM transactions WHERE user_id=$1 AND date::date=CURRENT_DATE AND status IN ('successful','pending','processing') AND metadata->'pricing'->>'agentPrice' IS NOT NULL`,[userId]);
  const usedToday=Number(r.rows[0]?.total||0), countToday=Number(r.rows[0]?.cnt||0);
  if(usedToday+thisTransactionAmount>limits.dailyLimit)return{ok:false,message:`This transaction would put you over your daily transaction limit of ₦${limits.dailyLimit.toLocaleString('en-NG',{minimumFractionDigits:2})}.`};
  if(countToday+1>limits.dailyCount)return{ok:false,message:`You've reached your daily transaction count limit of ${limits.dailyCount}.`};
  return{ok:true};
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
// provider_status is the provider's own verdict on the delivery. When it is present, it decides:
// an unrecognised value must never be rescued by the top-level "status":true, which only says the API call worked.
const ps=data?.data?.provider_status;
const providerSpoke=ps!==undefined&&ps!==null&&String(ps).trim()!=="";
const nested=data?.data?.status??data?.data?.transaction?.status??data?.transaction?.status??data?.state??data?.result;
const nestedSpoke=nested!==undefined&&nested!==null&&String(nested).trim()!=="";
const raw=providerSpoke?ps:(nestedSpoke?nested:data?.status);
if(typeof raw==="boolean")return raw?(responseOk?"successful":"unknown"):(responseOk?"failed":"unknown");
const value=String(raw??"").trim().toLowerCase();
if(!value)return "unknown";
if(/(pending|processing|initiated|queued|in progress|awaiting)/.test(value))return "pending";
if(/(refund|revers)/.test(value))return responseOk?"refunded":"unknown";
if(/(fail|unsuccess|not success|declin|reject|cancel|error|invalid|insufficient)/.test(value)||value==="false")return responseOk?"failed":"unknown";
if(/(success|complete|deliver)/.test(value)||value==="true")return "successful";
return "unknown";
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
return{success:false,outcome:"unknown",statusCode:response.status,data,providerReference,message:message||`VTUGATE returned an unconfirmed response (${response.status}).`};
}catch(e){return{success:false,outcome:"unknown",statusCode:e.name==="AbortError"?504:502,data:{},providerReference:null,message:e.name==="AbortError"?"VTUGATE did not respond in time. Your transaction is being verified.":"VTUGATE connection could not be confirmed. Your transaction is being verified."};}
finally{clearTimeout(timer);}}

async function fetchVTUGATEServices(all=true){return vtugateRequest(all?"api/v1/fetchallservices":"api/v1/fetchservices",{});}
async function getVTUGATEAccountDetails(){return vtugateRequest("api/v1/accountdetails",{});}
const vtugateServiceCache={at:0,data:[]};
// Dedicated cache for getVTUGATEDataServiceIds — see the comment inside that function for why
// it can't safely share vtugateServiceCache with the other resolvers.
const vtugateDataServiceCache={at:0,data:[]};
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
if(Date.now()-vtugateServiceCache.at>300000){
  const r=await fetchVTUGATEServices(true);
  if(!r.success)throw new Error(r.message||"Unable to load VTUGATE services.");
  const root=r.data?.data??r.data;
  vtugateServiceCache.data=Array.isArray(root)?root:[];
  vtugateServiceCache.at=Date.now();
}
// VTUGATE's /api/v1/fetchallservices returns one flat row per service. Each row is tagged
// with an explicit service_type, and the network/provider lives in a dedicated, type-specific
// field — never free text to fuzzy-match: network_name for airtime & data, tv_name for cable,
// disco for electricity. Matching those fields directly and exactly is simpler and strictly
// more reliable than searching for a name/description substring, since it can't be thrown off
// by however a given catalog entry happens to be worded.
const serviceTypeMap={airtime:"airtime",data:"data",cable:"tv",electricity:"electricity",education:"education"};
const providerFieldMap={airtime:"network_name",data:"network_name",cable:"tv_name",electricity:"disco"};
const wantedType=serviceTypeMap[category]||category;
const candidates=vtugateServiceCache.data.filter(row=>clean(row.service_type).toLowerCase()===wantedType);
const p=clean(provider).toLowerCase();
const field=providerFieldMap[category];
if(p&&field){
  const matches=candidates.filter(row=>clean(row[field]).toLowerCase()===p);
  if(matches.length)return Number(matches[0].service_id);
  if(candidates.length===0){const seenTypes=Array.from(new Set(vtugateServiceCache.data.map(row=>clean(row.service_type)||'(blank)'))).slice(0,20);throw new Error(`VTUGATE service ID for ${category} is not configured. VTUGATE's current service catalog has ${vtugateServiceCache.data.length} entries; none are service_type \"${wantedType}\". Types seen: ${seenTypes.join(', ')||'(none)'}. Check that this category is enabled on the VTUGATE account, or set VTUGATE_${String(category).toUpperCase()}_SERVICE_ID.`);}
  // No row's dedicated network field matched exactly. Safe to fall back to a lone candidate
  // only when its field is genuinely blank — that means the catalog isn't discriminating by
  // network at all for this category (delivery is decided by the phone number's real current
  // carrier), which is safe regardless of which network was requested. A lone candidate that
  // explicitly names a DIFFERENT specific network must never be used — that's the original
  // bug's exact shape, just with only one wrong candidate instead of several.
  if(candidates.length===1&&!clean(candidates[0][field]))return Number(candidates[0].service_id);
  throw new Error(`VTUGATE service ID for ${provider} ${category} could not be confirmed \u2014 refusing to guess a network among ${candidates.length} ${category} catalog entries. Check the VTUGATE service catalog and consider setting VTUGATE_SERVICE_MAP explicitly.`);
}
if(!candidates.length){const seenTypes=Array.from(new Set(vtugateServiceCache.data.map(row=>clean(row.service_type)||'(blank)'))).slice(0,20);throw new Error(`VTUGATE service ID for ${category} is not configured. VTUGATE's current service catalog has ${vtugateServiceCache.data.length} entries; none are service_type \"${wantedType}\". Types seen: ${seenTypes.join(', ')||'(none)'}. Check that this category is enabled on the VTUGATE account, or set VTUGATE_${String(category).toUpperCase()}_SERVICE_ID.`);}
return Number(candidates[0].service_id);
}

// VTUGATE's electricity catalog does not key every DISCO by its common abbreviation the
// way the BOLTIV electricity page's provider buttons do. IKEDC, EKEDC, AEDC and KEDCO
// happen to match their lowercased abbreviation, but PHED, IBEDC, EEDC, JED, KAEDCO,
// BEDC and YEDC are keyed by a city/region name instead (portharcourt, ibadan, enugu,
// jos, kaduna, benin, yola). Sending the plain lowercased abbreviation for those seven
// never matches a catalog row, so verification/purchase fails for most DISCOs even
// though the request is well-formed. This alias table lists every code seen for each
// abbreviation; resolveElectricityDisco tries each in turn against the live catalog so
// a future VTUGATE naming change doesn't silently reintroduce this failure, and it
// returns the matched catalog code so callers send VTUGATE the value it actually
// recognizes rather than the display abbreviation.
const ELECTRICITY_DISCO_ALIASES={
  ikedc:["ikedc"],ekedc:["ekedc"],aedc:["aedc"],kedco:["kedco"],
  phed:["portharcourt","phed"],ibedc:["ibadan","ibedc"],eedc:["enugu","eedc"],
  jed:["jos","jed"],kaedco:["kaduna","kaedco"],bedc:["benin","bedc"],
  yedc:["yola","yedc"],abedc:["aba","abedc"]
};
async function resolveElectricityDisco(discoInput){
  const abbrev=clean(discoInput).toLowerCase();
  if(!abbrev)throw new Error("Electricity provider is required.");
  const explicit=VTUGATE_SERVICE_MAP?.[abbrev]??VTUGATE_SERVICE_MAP?.[abbrev.toUpperCase()];
  if(Number(explicit)>0)return{serviceId:Number(explicit),disco:abbrev};
  if(Date.now()-vtugateServiceCache.at>300000){
    const r=await fetchVTUGATEServices(true);
    if(!r.success)throw new Error(r.message||"Unable to load VTUGATE services.");
    const root=r.data?.data??r.data;
    vtugateServiceCache.data=Array.isArray(root)?root:[];
    vtugateServiceCache.at=Date.now();
  }
  const candidates=vtugateServiceCache.data.filter(row=>clean(row.service_type).toLowerCase()==="electricity");
  const aliases=ELECTRICITY_DISCO_ALIASES[abbrev]||[abbrev];
  for(const alias of aliases){
    const match=candidates.find(row=>clean(row.disco).toLowerCase()===alias);
    if(match)return{serviceId:Number(match.service_id),disco:alias};
  }
  const seen=Array.from(new Set(candidates.map(row=>clean(row.disco)||'(blank)')));
  throw new Error(`VTUGATE service ID for ${abbrev} electricity could not be confirmed \u2014 none of the known codes (${aliases.join(", ")}) matched the live catalog. Discos VTUGATE currently reports: ${seen.join(", ")||'(none)'}. Check the VTUGATE dashboard/catalog or set VTUGATE_SERVICE_MAP.`);
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

const PLAN_ROW_NAME_FIELDS=['plan_name','planName','name','plan','data_plan','dataPlan','bundle_name','bundleName','bundle','product_name','productName','description','title','label'];
const PLAN_ROW_PRICE_FIELDS=['vendor_price','vendorPrice','agent_price','agentPrice','user_price','userPrice','merchant_price','merchantPrice','retail_price','retailPrice','selling_price','sellingPrice','sell_price','sellPrice','price','amount','cost','plan_price','planPrice','amount_to_charge','amountToCharge'];
// Looks only at the object's own keys (findCatalogField also searches inside children).
function ownCatalogField(value,names){
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const wanted=new Set(names.map(x=>String(x).replace(/[^a-z0-9]/gi,'').toLowerCase()));
  for(const [key,val] of Object.entries(value)){
    if(wanted.has(String(key).replace(/[^a-z0-9]/gi,'').toLowerCase())&&val!==undefined&&val!==null&&String(val).trim()!=='')return val;
  }
  return undefined;
}
// A wrapper such as {provider_status, data_plans:[...]} must not be mistaken for a plan: its nested search borrows the first
// plan's code/name/price, and that hollow copy then blocks the real first plan as a "duplicate".
function holdsPlanRows(value){
  const isRow=v=>v&&typeof v==='object'&&!Array.isArray(v)&&ownCatalogField(v,PLAN_ROW_NAME_FIELDS)!==undefined&&ownCatalogField(v,PLAN_ROW_PRICE_FIELDS)!==undefined;
  return Object.values(value).some(v=>Array.isArray(v)?v.some(isRow):isRow(v));
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
  const hasPlanSignals=!holdsPlanRows(value)&&(id>0||clean(idValue)!=='')&&(price>0||clean(priceValue)!=='')&&name!=='';
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
// This function keeps its own cache (vtugateDataServiceCache) rather than reusing the shared
// vtugateServiceCache that getVTUGATEServiceId/getVTUGATEEducationProducts/resolveElectricityDisco
// populate with raw catalog rows. Those functions and this one store incompatible shapes under
// the same 5-minute freshness window — whichever populated the cache last "wins" for everyone
// else reading it within that window. When a raw-row populate won, structuredMatches here always
// came back empty (raw rows use x.service_type/x.network_name, not x.serviceType/x.networkName),
// which fell through to the alias fallback below and crashed on x.hay being undefined (raw rows
// don't have a .hay field at all). A private cache removes the collision entirely.
if(Date.now()-vtugateDataServiceCache.at>300000){
  const r=await fetchVTUGATEServices(true);
  if(r.success){
    const root=r.data?.data??r.data;
    const records=[];
    const visit=(value,depth=0)=>{
      if(!value||depth>8)return;
      if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}
      if(typeof value!=='object')return;
      const id=Number(value.service_id??value.serviceId??value.serviceID??value.id??value.service?.id??value.service?.serviceId??0);
      const hay=[value.name,value.service_name,value.serviceName,value.service_title,value.title,value.label,value.code,value.service_code,value.serviceCode,value.slug,value.type,value.category,value.service_type,value.serviceType,value.provider,value.network,value.network_name,value.networkName,value.data_type,value.dataType,value.description,value.service?.name,value.service?.service_name,value.service?.code].filter(v=>v!==undefined&&v!==null).join(' ').toLowerCase();
      const serviceType=String(value.service_type||value.serviceType||'').toLowerCase();
      const networkName=String(value.network_name||value.networkName||value.network||'').toLowerCase();
      if(id>0&&hay)records.push({id,hay,serviceType,networkName,raw:value});
      for(const [k,v] of Object.entries(value)){if(['raw','meta','pagination'].includes(k))continue;visit(v,depth+1);}
    };
    visit(root);
    vtugateDataServiceCache.data=records;
    vtugateDataServiceCache.at=Date.now();
  }
}
// Primary, precise match: VTUGATE tags each service with an explicit service_type
// and network_name — use those directly rather than scanning free text, which can
// accidentally pull in other networks' services or unrelated business/broadband products.
const structuredMatches=vtugateDataServiceCache.data.filter(x=>x.serviceType==='data'&&x.networkName===selected.toLowerCase());
if(structuredMatches.length){
  for(const x of structuredMatches)add(x.id);
}else{
  // Fallback for older/differently-shaped VTUGATE responses that lack service_type/network_name.
  const aliases=['data','mobile data','internet data','data bundle','data bundles','data plan','data plans','mobile data bundle'];
  const has=(hay,w)=>{const safeHay=String(hay||'');const t=String(w).toLowerCase();return safeHay===t||safeHay.includes(` ${t} `)||safeHay.startsWith(`${t} `)||safeHay.endsWith(` ${t}`)||safeHay.includes(t);};
  const matches=vtugateDataServiceCache.data.filter(x=>aliases.some(w=>has(x.hay,w)));
  const networkMatches=matches.filter(x=>has(x.hay,selected.toLowerCase()));
  for(const x of networkMatches)add(x.id);
}
if(!ids.length)throw new Error(`VTUGATE service ID for ${selected} data is not configured.`);
return ids;
}

// Smallest retail data bundle offered. 1GB is stored as 1024MB when parsed from a "1GB" name/unit,
// but some providers report it as 1000 in an MB field, so 1000 is the cutoff: it keeps every 1GB plan
// and excludes anything smaller (e.g. 500MB, 750MB).
const MIN_DATA_PLAN_MB=1000;
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
  let sizeMb=parseDataSizeMb(p,name);
  if(sizeMb<MIN_DATA_PLAN_MB){const gbName=String(name).match(/(\d+(?:\.\d+)?)\s*GB\b/i);if(gbName&&Number(gbName[1])>=1)sizeMb=Math.round(Number(gbName[1])*1024);}
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
const dropped={noCodeOrPrice:[],tooSmall:[],nonRetail:[],otherNetwork:[]};
const cleaned=[];
for(const p of normalized){
  if(!p.plan_code||!(p.price>0)||!p.name){dropped.noCodeOrPrice.push(p.name||p.plan_code||"?");continue;}
  if(!(Number(p.size_mb||0)>=MIN_DATA_PLAN_MB)){dropped.tooSmall.push(p.name);continue;}
  if(isNonRetail(p.name)){dropped.nonRetail.push(p.name);continue;}
  if(hasOtherNetwork&&p.network_name!==selected){dropped.otherNetwork.push(p.name);continue;}
  cleaned.push(p);
}
// VTUGATE's current /api/v1/fetchdataplans returns one flat list of plans per network with no
// sales-channel tag at all (no SME/Gifting/Awoof distinction in the response) — it already does
// the cross-provider price/reliability comparison for managed-mode accounts server-side, and
// surfaces the result via delivery_rate/delivery_comment instead. Requiring sales_channel to be
// SME or Gifting here used to dedupe an older provider's channel-tagged catalog, but against the
// current API it matches nothing and silently empties the plan list. Multiple rows can still share
// the exact same bundle size+validity (e.g. two providers under managed mode); keep only the best
// one per (size, validity): prefer the most reliable delivery track record, and use price as the
// tiebreaker.
const bestByBundle=new Map();
for(const p of cleaned){
  const nameKey=String(p.name||'').toLowerCase().replace(/validity/g,'').replace(/[^a-z0-9.+]/g,'');
  const bundleKey=p.size_mb>0&&p.validity_days>0?`${p.size_mb}:${p.validity_days}:${nameKey}`:`unkeyed:${p.service_id}:${p.plan_code}`;
  const existing=bestByBundle.get(bundleKey);
  if(!existing){bestByBundle.set(bundleKey,p);continue;}
  const pRate=p.delivery_rate??50, exRate=existing.delivery_rate??50;
  if(pRate>exRate||(pRate===exRate&&p.price<existing.price))bestByBundle.set(bundleKey,p);
}
const result=Array.from(bestByBundle.values());
const nowTs=Date.now();
if(!fetchVTUGATEDataPlans._logAt)fetchVTUGATEDataPlans._logAt={};
if(nowTs-(fetchVTUGATEDataPlans._logAt[selected]||0)>300000){
  fetchVTUGATEDataPlans._logAt[selected]=nowTs;
  const sample=list=>list.slice(0,8).join(" | ");
  console.log("DATA PLANS "+selected+":",JSON.stringify({requestedServiceIds:serviceIds,received:raw.length,shown:result.length,collapsedAsDuplicates:cleaned.length-result.length,
    droppedNoCodeOrPrice:dropped.noCodeOrPrice.length,droppedTooSmall:dropped.tooSmall.length,droppedNonRetail:dropped.nonRetail.length,droppedOtherNetwork:dropped.otherNetwork.length,
    nonRetailExamples:sample(dropped.nonRetail),tooSmallExamples:sample(dropped.tooSmall)}));
}
return result;
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
let vtugateRequeryNextAt=0;
async function vtugateRequeryThrottle(){const now=Date.now();const wait=Math.max(0,vtugateRequeryNextAt-now);vtugateRequeryNextAt=Math.max(now,vtugateRequeryNextAt)+1100;if(wait)await new Promise(r=>setTimeout(r,wait));}
async function getVTUGATETransaction(providerReference,merchantReference=null,service=""){
if(String(service||"").toLowerCase()==="international"){
if(!/^\d+$/.test(String(providerReference||"").trim()))return{success:false,outcome:"unknown",message:"Missing provider transaction id for international requery."};
await vtugateRequeryThrottle();
const ir=await vtugateRequest("api/v1/international/topupstatus",{transaction_id:Number(providerReference)});
if(ir.outcome==="successful")return{success:true,outcome:"successful",data:ir.data,providerReference:String(providerReference),message:ir.message};
if(ir.outcome==="failed"||ir.outcome==="refunded")return{success:false,outcome:ir.outcome,data:ir.data,providerReference:String(providerReference),message:ir.message};
return{success:false,outcome:"unknown",data:ir.data,providerReference:String(providerReference),message:ir.message||"VTUGATE transaction status is still unavailable."};
}
const lookupReference=clean(providerReference||merchantReference);
if(!lookupReference)return{success:false,outcome:"unknown",message:"Missing transaction reference for VTUGATE requery."};
// VTUGATE transactionstatus expects either its numeric transaction_id or the
// original external_reference. Boltiv's own reference must be sent as
// external_reference, never as transaction_id. When we have both, send both
// so VTUGATE can use the precise ID while still validating the original ref.
const payload={requery:true};
if(providerReference && /^\d+$/.test(String(providerReference).trim())) payload.transaction_id=Number(providerReference);
if(merchantReference) payload.external_reference=clean(merchantReference);
if(!payload.transaction_id && !payload.external_reference) return{success:false,outcome:"unknown",message:"Missing valid VTUGATE transaction identifier for requery."};
await vtugateRequeryThrottle();
const r=await vtugateRequest("api/v1/transactionstatus",payload);
const confirmedReference=r.providerReference||providerReference||null;
if(r.outcome==="successful")return{success:true,outcome:"successful",data:r.data,providerReference:confirmedReference,message:r.message};
if(r.outcome==="failed"||r.outcome==="refunded")return{success:false,outcome:r.outcome,data:r.data,providerReference:confirmedReference,message:r.message};
return{success:false,outcome:"unknown",data:r.data,providerReference:confirmedReference,message:r.message||"VTUGATE transaction status is still unavailable."};
}

let reconcileBusy=false;
async function reconcileVTUGATETransactions(){
if(reconcileBusy)return{success:true,skipped:true};
reconcileBusy=true;
try{return await reconcileVTUGATETransactionsRun();}finally{reconcileBusy=false;}
}
async function reconcileVTUGATETransactionsRun(){
let rows=[];
try{rows=(await db(`(SELECT id,reference,provider_reference,service FROM transactions WHERE status IN ('processing','pending') AND date>NOW()-INTERVAL '24 hours' ORDER BY date ASC LIMIT 100)
 UNION ALL
 (SELECT id,reference,provider_reference,service FROM transactions WHERE status IN ('processing','pending') AND date<=NOW()-INTERVAL '24 hours' ORDER BY date DESC LIMIT 50)`)).rows;}
catch(e){console.error("VTUGATE RECONCILIATION QUERY ERROR:",e);return{success:false,error:e.message};}
let finalized=0,unverified=0;
for(const row of rows){
try{
const lookupReference=row.provider_reference||row.reference;
const r=await getVTUGATETransaction(row.provider_reference,row.reference,row.service);
if(r.outcome==="successful"||r.outcome==="failed"||r.outcome==="refunded"){
await finalizeVTUTransaction(row.id,r.outcome,r.data||{},r.providerReference||row.provider_reference||null);
finalized++;
}else{
unverified++;
console.log("VTUGATE TRANSACTION STILL UNVERIFIED:",JSON.stringify({transactionId:row.id,reference:row.reference,providerReference:row.provider_reference,lookupReference,status:r.outcome,providerMessage:r.message,providerRaw:JSON.stringify(r.data||{}).slice(0,500)}));
}
}catch(e){
unverified++;
console.error("VTUGATE RECONCILIATION TRANSACTION ERROR:",JSON.stringify({transactionId:row.id,reference:row.reference,providerReference:row.provider_reference,error:e.message}));
}}
return{success:true,checked:rows.length,finalized,unverified};
}

async function reconcilePendingTransactions(){return reconcileVTUGATETransactions();}

/* Purchases we settled in the last 2 hours (the window in which VTUGATE itself auto-settles) are asked about again every ~40 minutes.
   If the provider disagrees with what BOLTIV recorded, the transaction is flagged (metadata.provider_mismatch) and logged.
   Nothing is refunded or charged automatically here. */
let verifySuccessBusy=false;
async function verifyRecentSuccessfulTransactions(){
  if(verifySuccessBusy)return;
  verifySuccessBusy=true;
  try{
    const rows=(await db(`SELECT id,reference,provider_reference,status,service FROM transactions
      WHERE status IN ('successful','refunded') AND completed_at>NOW()-INTERVAL '110 minutes' AND completed_at<NOW()-INTERVAL '10 minutes'
        AND (status='successful' OR provider_reference IS NOT NULL)
        AND NOT (COALESCE(metadata,'{}'::jsonb) ? 'provider_mismatch')
        AND (COALESCE(metadata->>'provider_checked_at','')='' OR (metadata->>'provider_checked_at')::timestamptz<NOW()-INTERVAL '40 minutes')
      ORDER BY completed_at DESC LIMIT 40`)).rows;
    for(const row of rows){
      try{
        const r=await getVTUGATETransaction(row.provider_reference,row.reference,row.service);
        const now=new Date().toISOString();
        const mismatch=(row.status==="successful"&&(r.outcome==="failed"||r.outcome==="refunded"))||(row.status==="refunded"&&r.outcome==="successful");
        if(mismatch){
          const d=(r.data&&r.data.data)||{};
          const flag={provider_checked_at:now,provider_mismatch:{boltiv_status:row.status,provider_outcome:r.outcome,provider_message:clean(r.message).slice(0,300),wallet_adjusted:d.wallet_adjusted===true,reconciliation_action:d.reconciliation_action||null,at:now}};
          await db(`UPDATE transactions SET metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[row.id,JSON.stringify(flag)]);
          console.error("PROVIDER MISMATCH (BOLTIV says "+row.status+", provider says "+r.outcome+"):",JSON.stringify({transactionId:row.id,reference:row.reference,providerReference:row.provider_reference,walletAdjusted:d.wallet_adjusted===true,reconciliationAction:d.reconciliation_action||null,providerMessage:r.message}));
        }else if(r.outcome==="successful"||r.outcome==="failed"||r.outcome==="refunded"){
          await db(`UPDATE transactions SET metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[row.id,JSON.stringify({provider_checked_at:now})]);
        }
      }catch(e){console.error("VERIFY SETTLED ERROR:",row.reference,e?.message||e);}
    }
  }catch(e){console.error("VERIFY SETTLED SWEEP ERROR:",e?.message||e);}
  finally{verifySuccessBusy=false;}
}

async function getAgentProfile(userId){
  const r=await db(`SELECT user_id,agent_id,status,tier,max_transaction_override,daily_limit_override,daily_count_override,activated_at,updated_at FROM agent_profiles WHERE user_id=$1 LIMIT 1`,[userId]);
  if(!r.rows.length)return null;
  return r.rows[0];
}

async function getEffectiveAgentService(userId,serviceKey){
  const agent=await getAgentProfile(userId);
  if(!agent||String(agent.status).toLowerCase()!=='active')return {isAgent:false,enabled:true,agent:null,markupOverride:null};
  const r=await db(`SELECT enabled,markup_pct_override FROM agent_services WHERE user_id=$1 AND service_key=$2 LIMIT 1`,[userId,serviceKey]);
  // Missing per-agent rows inherit the platform service availability.
  return {isAgent:true,enabled:r.rows.length?Boolean(r.rows[0].enabled):true,agent,markupOverride:r.rows.length&&r.rows[0].markup_pct_override!=null?Number(r.rows[0].markup_pct_override):null};
}

function makeAgentId(){
  return `BVT-${Date.now().toString(36).toUpperCase()}-${crypto.randomInt(100,999)}`;
}

async function activateAgentForUser(user,req){
  if(!user||!user.user_id)return{success:false,statusCode:401,message:'Unauthorized.'};
  if(String(user.status||'active').toLowerCase()==='suspended')return{success:false,statusCode:403,message:'Your BOLTIV account is suspended.'};
  const existing=await getAgentProfile(user.user_id);
  if(existing)return{success:true,alreadyAgent:true,agent:existing,message:'Your BOLTIV Agent account is already active.'};
  const wallet=await getWallet(user.user_id);
  const balance=Number(wallet?.balance||0);
  const limits=await getAgentLimits(null);
  const minWalletBalance=limits.minWalletBalance;
  if(balance<minWalletBalance)return{success:false,statusCode:400,code:'AGENT_MINIMUM_BALANCE',message:`You need at least ₦${minWalletBalance.toLocaleString('en-NG',{minimumFractionDigits:2})} in your BOLTIV wallet to become an Agent. Your current balance is ₦${balance.toLocaleString('en-NG',{minimumFractionDigits:2})}.`,requiredBalance:minWalletBalance,currentBalance:balance};
  // KYC gate: BOLTIV does not treat "has a static account number" as proof of identity by
  // itself — it relies on Flutterwave's own verification, which is what actually gates
  // whether a permanent/static virtual account gets created at all (createFlutterwaveVirtualAccount
  // requires a valid NIN or BVN and only succeeds if Flutterwave's API accepts it). So requiring
  // an active static account here IS the KYC check, reusing the existing funding infrastructure
  // rather than inventing a separate verification flow.
  const staticAccount=await getFlutterwaveStaticFundingAccount(user);
  if(!staticAccount.success||!staticAccount.account)return{success:false,statusCode:400,code:'AGENT_STATIC_ACCOUNT_REQUIRED',message:'Set up your dedicated BOLTIV funding account (requires NIN or BVN verification) before activating your Agent account.'};
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const dupe=await client.query(`SELECT user_id,agent_id,status,tier,activated_at,updated_at FROM agent_profiles WHERE user_id=$1 OR agent_id=$2 LIMIT 1 FOR UPDATE`,[user.user_id,makeAgentId()]);
    if(dupe.rows.length&&dupe.rows[0].user_id===user.user_id){await client.query('COMMIT');return{success:true,alreadyAgent:true,agent:dupe.rows[0],message:'Your BOLTIV Agent account is already active.'};}
    let agentId;
    for(let i=0;i<5;i++){const candidate=makeAgentId();const exists=await client.query(`SELECT 1 FROM agent_profiles WHERE agent_id=$1`,[candidate]);if(!exists.rows.length){agentId=candidate;break;}}
    if(!agentId)throw new Error('Unable to create a unique Agent ID.');
    const r=await client.query(`INSERT INTO agent_profiles(user_id,agent_id,status,tier,activated_at,updated_at) VALUES($1,$2,'active','standard',NOW(),NOW()) RETURNING user_id,agent_id,status,tier,activated_at,updated_at`,[user.user_id,agentId]);
    const services=await client.query(`SELECT key FROM services ORDER BY key`);
    for(const svc of services.rows){
      await client.query(`INSERT INTO agent_services(user_id,service_key,enabled,updated_at) VALUES($1,$2,TRUE,NOW()) ON CONFLICT(user_id,service_key) DO NOTHING`,[user.user_id,svc.key]);
    }
    await client.query('COMMIT');
    try{await addNotification(user.user_id,'BOLTIV Agent activated',`Your BOLTIV Agent account ${agentId} is now active. Your existing wallet balance remains available as working capital.`,'account');}catch{}
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) SELECT id,'agent_activation','user',$1,$2::jsonb,$3 FROM admins ORDER BY id LIMIT 1`,[user.user_id,JSON.stringify({agent_id:agentId,minimum_balance:minWalletBalance,static_account:staticAccount.account.account_number}),requestIp(req)]).catch(()=>{});
    return{success:true,agent:r.rows[0],message:'You are now a BOLTIV Agent.'};
  }catch(e){try{await client.query('ROLLBACK')}catch{};throw e;}finally{client.release();}
}

async function processVTUTransaction(user,data,opts={}){
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
const agentService=await getEffectiveAgentService(userId,service);
if(agentService.isAgent&&!agentService.enabled)return{success:false,statusCode:403,message:`${serviceRecord.name||service} is not enabled for your BOLTIV Agent account.`};
if(!validAmount(amount))return{success:false,statusCode:400,message:"Invalid amount."};
if(["airtime","data","cable","electricity"].includes(service)&&!/^0\d{10}$/.test(clean(data.phone||data.providerPayload?.phone||"08000000000")))return{success:false,statusCode:400,message:"Please enter a valid 11-digit phone number."};
const idem=clean(data.idempotencyKey||data.idempotency_key);const security=await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`,[userId]);if(!security.rows[0]?.transaction_pin_hash)return{success:false,statusCode:400,message:"Please set your Transaction PIN before making a purchase."};if(opts.skipPin!==true){const suppliedPin=String(data.transactionPin||"");if(!/^\d{4}$/.test(suppliedPin)||!verifyPassword(suppliedPin,security.rows[0].transaction_pin_hash))return{success:false,statusCode:400,message:"Incorrect Transaction PIN."};}
let providerPayload={},recipient=clean(data.phone||data.providerPayload?.phone||user.phone),pricingMeta={providerCost:null,customerPrice:amount,grossProfit:0};
if(service==="data"){
const requestedPlanCode=clean(data.plan_code??data.providerPayload?.plan_code??data.plan_id??data.providerPayload?.plan_id??"");const requestedServiceId=Number(data.service_id??data.providerPayload?.service_id??0);const fallbackLookupKey=clean(data.bundle_id??data.providerPayload?.bundle_id??"");const planCode=(requestedServiceId>0&&requestedPlanCode)?planLookupKey(requestedPlanCode,requestedServiceId):(fallbackLookupKey||requestedPlanCode);const network=normalizeDataNetwork(data.network||data.providerPayload?.network);if(!planCode)return{success:false,statusCode:400,message:"Plan code is required."};let authoritative;try{authoritative=await getAuthoritativeVTUGATEDataPlan(network,planCode);}catch(e){console.error("VTUGATE unavailable (Unable to verify the current data plan price.):",e.message);return{success:false,statusCode:503,message:"Network not available. Please try again later."};}if(Math.abs(amount-Number(authoritative.customer_price))>.009)return{success:false,statusCode:400,message:"The selected data plan price has changed. Please refresh the plans and try again."};pricingMeta={providerCost:authoritative.provider_price,customerPrice:authoritative.customer_price,grossProfit:Number((authoritative.customer_price-authoritative.provider_price).toFixed(2)),network:authoritative.network_name,plan:authoritative.name,validityDays:Number(authoritative.validity_days)||null};const providerPlanCode=clean(authoritative.plan_code||authoritative.code||authoritative.provider_code||"");if(!providerPlanCode)return{success:false,statusCode:503,message:"VTUGATE did not return a plan code for the selected data plan."};providerPayload={service_id:Number(authoritative.service_id),code:providerPlanCode,plan_code:providerPlanCode,phone:recipient,phone_number:recipient,msisdn:recipient,amount,ref:null};
}else if(service==="exam_pin"){
const productId=Number(data.product_id||data.providerPayload?.product_id||0),quantity=Number(data.quantity||data.providerPayload?.quantity||1);if(!Number.isInteger(productId)||productId<=0)return{success:false,statusCode:400,message:"Invalid education PIN product."};if(![1,2,5].includes(quantity))return{success:false,statusCode:400,message:"Education PIN quantity must be 1, 2, or 5."};const serviceId=productId;let unitPrice;try{unitPrice=await getVTUGATEEducationPrice(serviceId);}catch(e){console.error("VTUGATE unavailable (Unable to verify the current education PIN price.):",e.message);return{success:false,statusCode:503,message:"Network not available. Please try again later."};}const productCode=clean(data.product_code||data.providerPayload?.product_code||data.exam||"waec");const expectedTotal=Number((unitPrice*quantity).toFixed(2));if(Math.abs(amount-expectedTotal)>.009)return{success:false,statusCode:400,message:"The selected education PIN price has changed. Please refresh the products and try again."};pricingMeta={providerCost:Number((unitPrice*quantity).toFixed(2)),customerPrice:expectedTotal,grossProfit:Number((expectedTotal-unitPrice*quantity).toFixed(2)),plan:productCode.toUpperCase()};providerPayload={service_id:serviceId,phone:recipient||user.phone||"08000000000",phone_number:recipient||user.phone||"08000000000",msisdn:recipient||user.phone||"08000000000",quantity,product_code:productCode,ref:null};
}else if(service==="airtime"){
const network=normalizeDataNetwork(data.network||data.providerPayload?.network);if(!network)return{success:false,statusCode:400,message:"Unsupported network."};if(!/^0\d{10}$/.test(recipient))return{success:false,statusCode:400,message:"Please enter a valid 11-digit phone number."};const detectedNetwork=detectNetworkFromPhone(recipient);const networkConfirmed=data.networkConfirmed===true||data.providerPayload?.networkConfirmed===true;if(detectedNetwork&&detectedNetwork!==network&&!networkConfirmed)return{success:false,statusCode:409,message:`This number looks like a ${detectedNetwork} line, but ${network} was selected. Numbers can be ported \u2014 confirm the network and try again.`,detectedNetwork,requiresNetworkConfirmation:true};let serviceId;try{serviceId=await getVTUGATEServiceId("airtime",network);}catch(e){console.error("VTUGATE unavailable (Unable to verify the airtime service for this network right now.):",e.message);return{success:false,statusCode:503,message:"Network not available. Please try again later."};}providerPayload={service_id:serviceId,network,amount,phone:recipient,phone_number:recipient,msisdn:recipient,airtime_amount:amount,ref:null};pricingMeta.network=network;
}else if(service==="cable"){
const providerName=clean(data.provider||data.providerPayload?.provider).toUpperCase();let serviceId;try{serviceId=await getVTUGATEServiceId("cable",providerName);}catch(e){console.error("VTUGATE unavailable (Unable to verify the cable TV service for this provider right now.):",e.message);return{success:false,statusCode:503,message:"Network not available. Please try again later."};}const plan=clean(data.plan||data.providerPayload?.plan);const iucnumber=clean(data.smartcard||data.providerPayload?.smartcard);if(!plan)return{success:false,statusCode:400,message:"Cable TV plan is required."};if(!/^\d{8,20}$/.test(iucnumber))return{success:false,statusCode:400,message:"Invalid smartcard/IUC number."};const expectedPrice=getCablePlanPrice(providerName,plan);if(expectedPrice===null)return{success:false,statusCode:400,message:"The selected cable TV plan is not recognized."};if(Math.abs(amount-expectedPrice)>.009)return{success:false,statusCode:400,message:"The selected cable TV plan price has changed. Please refresh and try again."};pricingMeta={providerCost:expectedPrice,customerPrice:expectedPrice,grossProfit:0,network:providerName,plan};providerPayload={service_id:serviceId,provider:providerName,iucnumber,smartcard:iucnumber,phone:recipient,phone_number:recipient,msisdn:recipient,plan,package:plan,amount,ref:null};
}else if(service==="electricity"){
const discoAbbrev=clean(data.provider||data.providerPayload?.provider||data.disco||data.providerPayload?.disco).toLowerCase();if(!discoAbbrev)return{success:false,statusCode:400,message:"Electricity provider is required."};let serviceId,providerDisco;try{({serviceId,disco:providerDisco}=await resolveElectricityDisco(discoAbbrev));}catch(e){console.error("VTUGATE unavailable (Unable to verify the electricity service right now.):",e.message);return{success:false,statusCode:503,message:"Network not available. Please try again later."};}const meterTypeRaw=clean(data.meterType||data.providerPayload?.meterType||"Prepaid");const meterType=/^postpaid$/i.test(meterTypeRaw)?"Postpaid":"Prepaid";const meterNo=clean(data.meterNumber||data.providerPayload?.meterNumber||data.meter_no);if(meterNo.length<8)return{success:false,statusCode:400,message:"Invalid meter number."};if(amount<MIN_ELECTRICITY_AMOUNT)return{success:false,statusCode:400,message:`Minimum electricity purchase is \u20a6${MIN_ELECTRICITY_AMOUNT.toLocaleString("en-NG")}.`};// The customer pays exactly `amount` and sees only that. For a normal customer the meter is vended for
// `amount` minus the admin-set Markup % (of the amount) and Service Fee for Electricity, so BOLTIV keeps
// the difference. Agents keep the previous behaviour (vend = amount, priced from the agent wholesale rate below).
let vendAmount=amount;if(!agentService.isAgent){const ep=pricingConfig(serviceRecord);vendAmount=Number((amount*(1-Number(ep.markup_pct||0)/100)-Number(ep.service_fee||0)-Number(ep.markup_fixed||0)).toFixed(2));if(!(vendAmount>0))return{success:false,statusCode:400,message:"Unable to price this electricity purchase."};}
providerPayload={service_id:serviceId,meter_no:meterNo,disco:providerDisco,amount:vendAmount,phone_number:recipient||"08000000000",ref:null};pricingMeta.network=discoAbbrev.toUpperCase();pricingMeta.plan=meterType;pricingMeta={...pricingMeta,providerCost:vendAmount,customerPrice:amount,grossProfit:Number((amount-vendAmount).toFixed(2))};
}
let debitAmount=amount;
if(agentService.isAgent){
  // The cost basis an Agent's wholesale price is built from: the real provider cost when one
  // was established for this sale (data/exam_pin/cable/electricity all resolve a known VTUGATE
  // cost above); airtime has no independent provider cost (VTUGATE recharges face value), so the
  // requested face-value amount is used as the basis instead — the Agent still gets a lower
  // markup than a walk-in customer would, which is what makes it a wholesale rate.
  const costBasis=pricingMeta.providerCost!=null?Number(pricingMeta.providerCost):amount;
  const agentPricingRow=await getAgentPricingRow(service);
  if(agentPricingRow.active===false)return{success:false,statusCode:403,message:"Agent pricing for this service is currently disabled."};
  const agentPricing=agentPricingConfig(agentPricingRow,agentService.markupOverride);
  const agentPrice=customerPriceFromCost(costBasis,agentPricing);
  if(agentPrice==null)return{success:false,statusCode:400,message:"Unable to price this Agent transaction."};
  const customerSellingPrice=Number(data.customerSellingPrice??data.providerPayload?.customerSellingPrice);
  if(!Number.isFinite(customerSellingPrice)||customerSellingPrice<=0)return{success:false,statusCode:400,message:"Enter the price you're charging your customer."};
  debitAmount=agentPrice;
  const limitCheck=await checkAgentLimits(userId,agentService.agent,agentPrice);
  if(!limitCheck.ok)return{success:false,statusCode:400,message:limitCheck.message};
  // BOLTIV's own gross profit on an Agent sale is the Agent price minus BOLTIV's real provider
  // cost — NOT the B2C customerPrice-minus-cost figure computed above, since the Agent never
  // paid the B2C price. Recomputing here keeps admin revenue/reconciliation reporting (which
  // sums pricing.grossProfit) accurate instead of overstating agent-driven revenue.
  const boltivGrossProfit=pricingMeta.providerCost!=null?Number((agentPrice-Number(pricingMeta.providerCost)).toFixed(2)):0;
  pricingMeta={...pricingMeta,customerPrice:agentPrice,grossProfit:boltivGrossProfit,agentPrice,agentMarkupPct:agentPricing.markup_pct,customerSellingPrice:Number(customerSellingPrice.toFixed(2)),agentProfit:Number((customerSellingPrice-agentPrice).toFixed(2))};
}
const referenceValue=reference("BOLTIV-TX");providerPayload.ref=referenceValue;const reserved=await createVTUTransactionAndDebit({userId,service,amount:debitAmount,reference:referenceValue,recipient,idempotencyKey:idem,useBonus:data.useBonus===true,metadata:{provider:"vtugate",request:providerPayload,pricing:pricingMeta,...(opts.autopay?{autopay:opts.autopay}:{})}});if(!reserved.success)return{success:false,statusCode:400,message:reserved.message,balance:0};if(reserved.existing){const t=reserved.transaction;const wallet=await getWallet(userId);return{success:t.status==="successful"||t.status==="pending"||t.status==="processing",message:t.status==="successful"?"Transaction already completed.":"Transaction is already being processed.",reference:t.reference,status:t.status,amount:Number(t.amount),providerReference:t.provider_reference,balance:wallet?.balance??0,alreadyProcessed:true};}
let endpoint="";if(service==="airtime")endpoint="api/v1/buyairtime";else if(service==="data")endpoint="api/v1/buydata";else if(service==="exam_pin")endpoint="api/v1/buyeducation";else if(service==="cable")endpoint="api/v1/buycabletv";else if(service==="electricity")endpoint="api/v1/buyelectricity";
let providerResult;try{providerResult=await vtugateRequest(endpoint,providerPayload);}catch(e){providerResult={success:false,outcome:"unknown",statusCode:502,message:"VTUGATE connection could not be confirmed. Your transaction is being verified."};}
if(!providerResult.success)console.error("VTUGATE TRANSACTION NOT CONFIRMED:",JSON.stringify({endpoint,outcome:providerResult.outcome,sentPayload:{...providerPayload,ref:providerPayload.ref},providerMessage:providerResult.message,providerRawResponse:providerResult.data}));
const providerData=providerResult.data||{};const providerReference=providerResult.providerReference||findTransactionField(providerData,["transaction_id","external_reference","reference","transactionId","id"])||null;const finalized=await finalizeVTUTransaction(reserved.transaction.id,providerResult.outcome||"unknown",providerData,providerReference);const wallet=await getWallet(userId);if(finalized.status==="refunded")return{success:false,statusCode:providerResult.statusCode>=500?502:400,message:providerResult.message||"Transaction failed. Your wallet has been refunded.",reference:reserved.transaction.reference,providerReference,balance:wallet?.balance??0,status:"refunded"};const delivery=providerData?.data?.delivery||providerData?.delivery||null;const pins=providerData?.data?.pins||providerData?.pins||delivery?.pins||[];const token=service==="electricity"?(findTransactionField(providerData,["token","meter_token","recharge_token","standard_token","units_token","electricity_token","vend_token"])||delivery?.token||""):"";const units=service==="electricity"?(findTransactionField(providerData,["units","kwh","unit"])||""):"";return{success:true,statusCode:200,message:providerResult.message||(finalized.status==="pending"?"Your transaction is being processed.":"Transaction successful."),reference:reserved.transaction.reference,providerReference,balance:wallet?.balance??reserved.balance,status:finalized.status,providerData,delivery,pins,token,units,amountCharged:debitAmount};
}

/* ===================== BULK AIRTIME (VTUGATE /api/v1/buybulkairtime) =====================
   One provider call for up to 50 numbers, same network + amount for each. BOLTIV still keeps one
   ordinary airtime transaction per number, so history, receipts, refunds and revenue all work
   exactly as they do for a single purchase. Flow: debit every number up front -> one provider
   call (1-2 min) -> per-number settle: success = keep, failed = refund that number only. */
const BULK_AIRTIME_MAX=50,BULK_AIRTIME_MIN_AMOUNT=50;
const bulkAirtimeInFlight=new Set();
function normalizeBulkPhone(raw){
  let p=String(raw||"").replace(/[^\d+]/g,"");
  if(p.startsWith("+234"))p="0"+p.slice(4);
  else if(p.startsWith("234")&&p.length===13)p="0"+p.slice(3);
  else if(/^[789]\d{9}$/.test(p))p="0"+p;
  return p;
}
function parseBulkPhones(input){
  let items=[];
  if(Array.isArray(input))items=input;
  else{
    const s=String(input||"").trim();
    if(s.startsWith("[")){try{const j=JSON.parse(s);if(Array.isArray(j))items=j;}catch{}}
    if(!items.length)items=s.split(/[\s,;]+/);
  }
  const out=[],seen=new Set();
  for(const raw of items){
    const p=normalizeBulkPhone(raw);
    if(!p||seen.has(p))continue;
    seen.add(p);out.push(p);
  }
  return out;
}
const bulkPhoneKey=p=>String(p||"").replace(/\D/g,"").slice(-10);
async function processBulkAirtime(user,data){
  const userId=clean(user?.user_id);
  if(!userId)return{success:false,statusCode:401,message:"Unauthorized."};
  const serviceRecord=await getService("airtime");
  if(!serviceRecord||serviceRecord.enabled===false)return{success:false,statusCode:503,message:"This service is currently unavailable."};
  if(serviceRecord.maintenance===true)return{success:false,statusCode:503,message:"This service is currently under maintenance."};
  const agentService=await getEffectiveAgentService(userId,"airtime");
  if(agentService.isAgent)return{success:false,statusCode:403,message:"Bulk airtime is not available on Agent accounts yet."};
  const amount=Number(data.amount);
  if(!Number.isInteger(amount)||amount<BULK_AIRTIME_MIN_AMOUNT)return{success:false,statusCode:400,message:`Enter a whole-naira amount of at least \u20A6${BULK_AIRTIME_MIN_AMOUNT}.`};
  const network=normalizeDataNetwork(data.network);
  if(!network)return{success:false,statusCode:400,message:"Unsupported network."};
  const phones=parseBulkPhones(data.phones);
  if(!phones.length)return{success:false,statusCode:400,message:"Add at least one phone number."};
  const invalid=phones.filter(p=>!/^0\d{10}$/.test(p));
  if(invalid.length)return{success:false,statusCode:400,message:`${invalid.length} number${invalid.length>1?"s are":" is"} not valid. Fix or remove ${invalid.length>1?"them":"it"} and try again.`,invalidNumbers:invalid.slice(0,BULK_AIRTIME_MAX)};
  if(phones.length>BULK_AIRTIME_MAX)return{success:false,statusCode:400,message:`You can buy for up to ${BULK_AIRTIME_MAX} numbers at a time.`};
  const mismatched=phones.map(p=>({phone:p,detectedNetwork:detectNetworkFromPhone(p)})).filter(x=>x.detectedNetwork&&x.detectedNetwork!==network);
  if(mismatched.length&&data.networkConfirmed!==true)return{success:false,statusCode:409,requiresNetworkConfirmation:true,mismatchedNumbers:mismatched,message:`${mismatched.length} number${mismatched.length>1?"s look":" looks"} like a different network than ${network}. Numbers can be ported \u2014 confirm to continue.`};
  const security=await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`,[userId]);
  if(!security.rows[0]?.transaction_pin_hash)return{success:false,statusCode:400,message:"Please set your Transaction PIN before making a purchase."};
  const suppliedPin=String(data.transactionPin||"");
  if(!/^\d{4}$/.test(suppliedPin)||!verifyPassword(suppliedPin,security.rows[0].transaction_pin_hash))return{success:false,statusCode:400,message:"Incorrect Transaction PIN."};
  let serviceId;
  try{serviceId=await getVTUGATEServiceId("airtime",network);}
  catch(e){console.error("VTUGATE unavailable (bulk airtime service id):",e.message);return{success:false,statusCode:503,message:"Network not available. Please try again later."};}
  const total=Number((amount*phones.length).toFixed(2));
  const wallet0=await getWallet(userId);
  let available=Number(wallet0?.balance||0);
  if(data.useBonus===true){const c=await pool.connect();try{available+=await bonusAvailableFor(c,userId);}finally{c.release();}}
  if(available+0.009<total)return{success:false,statusCode:400,message:`Insufficient balance. ${phones.length} \u00D7 \u20A6${amount.toLocaleString("en-NG")} = \u20A6${total.toLocaleString("en-NG")}.`};
  if(bulkAirtimeInFlight.has(userId))return{success:false,statusCode:409,message:"A bulk airtime purchase is already in progress. Please wait for it to finish."};
  bulkAirtimeInFlight.add(userId);
  try{
    const batchId=reference("BOLTIV-BULK");
    const batchKey=clean(data.idempotencyKey||data.idempotency_key)||batchId;
    const results=[],reserved=[],existing=[];
    // 1) Reserve (debit) every number as its own airtime transaction.
    for(const phone of phones){
      const ref=reference("BOLTIV-TX");
      const idem=crypto.createHash("sha1").update(`${batchKey}:${phone}`).digest("hex");
      const meta={provider:"vtugate",request:{service_id:serviceId,network,amount,phone,bulk:true},pricing:{providerCost:null,customerPrice:amount,grossProfit:0,network},bulk:{batchId,size:phones.length}};
      let r;
      try{r=await createVTUTransactionAndDebit({userId,service:"airtime",amount,reference:ref,recipient:phone,idempotencyKey:idem,useBonus:data.useBonus===true,metadata:meta});}
      catch(e){console.error("BULK AIRTIME RESERVE ERROR:",e?.stack||e?.message||e);r={success:false,message:"Could not reserve this purchase."};}
      if(!r.success){results.push({phone,status:"failed",amount,message:(r.message||"Not processed.")+" You were not charged for this number."});continue;}
      if(r.existing){existing.push({phone,transaction:r.transaction});continue;}
      reserved.push({phone,transaction:r.transaction});
    }
    // Same idempotency key replayed: report what already happened, never re-send to the provider.
    for(const e of existing){
      const st=e.transaction.status;
      results.push({phone:e.phone,status:st==="successful"?"success":(st==="refunded"||st==="failed"?"failed":"pending"),amount,reference:e.transaction.reference,providerReference:e.transaction.provider_reference||null,message:st==="successful"?"Airtime purchase was successful":(st==="refunded"?"Failed and refunded":"Still being confirmed")});
    }
    // 2) One provider call for everything that was reserved.
    if(reserved.length){
      let pr;
      try{pr=await vtugateRequest("api/v1/buybulkairtime",{service_id:serviceId,amount,phones:reserved.map(x=>x.phone).join(",")},{timeoutMs:Number(process.env.VTUGATE_BULK_TIMEOUT_MS||240000)});}
      catch(e){pr={success:false,outcome:"unknown",statusCode:502,data:{},message:"VTUGATE connection could not be confirmed."};}
      const rows=Array.isArray(pr.data?.data?.results)?pr.data.data.results:[];
      const byPhone=new Map();for(const row of rows)byPhone.set(bulkPhoneKey(row?.phone),row);
      // A clean rejection with no per-number results means nothing was processed (bad request,
      // provider balance, etc.) -> safe to refund everything. Timeouts / 5xx are NOT treated this way.
      const rejected=!rows.length&&pr.data?.status===false&&[400,401,403,404,422].includes(pr.statusCode);
      if(!rows.length)console.error("BULK AIRTIME NO PER-NUMBER RESULTS:",JSON.stringify({batchId,statusCode:pr.statusCode,outcome:pr.outcome,message:pr.message,raw:JSON.stringify(pr.data||{}).slice(0,500)}));
      for(const item of reserved){
        const row=byPhone.get(bulkPhoneKey(item.phone));
        let outcome="pending",ref=null,msg="";
        if(row){
          const st=String(row.status||"").trim().toLowerCase();
          ref=row.transaction_id!=null?String(row.transaction_id):null;msg=clean(row.message);
          if(/^(success|successful|completed|delivered)$/.test(st))outcome="successful";
          else if(/(fail|error|reject|declin|invalid|insufficient|cancel)/.test(st))outcome="failed";
        }else if(rejected){outcome="failed";msg=clean(pr.message);}
        let finalStatus="pending";
        try{const f=await finalizeVTUTransaction(item.transaction.id,outcome,{bulk:true,batch_id:batchId,result:row||null,message:msg},ref,{quiet:true});finalStatus=f.status;}
        catch(e){console.error("BULK AIRTIME FINALIZE ERROR:",JSON.stringify({batchId,reference:item.transaction.reference,error:e?.message}));}
        results.push({phone:item.phone,status:finalStatus==="successful"?"success":(finalStatus==="refunded"?"failed":"pending"),amount,reference:item.transaction.reference,providerReference:ref,message:finalStatus==="successful"?(msg||"Airtime purchase was successful"):(finalStatus==="refunded"?((msg||"Could not be delivered")+". Refunded to your wallet."):"Still being confirmed with the provider.")});
      }
    }
    const order=new Map(phones.map((p,i)=>[p,i]));results.sort((a,b)=>order.get(a.phone)-order.get(b.phone));
    const ok=results.filter(r=>r.status==="success"),bad=results.filter(r=>r.status==="failed"),pend=results.filter(r=>r.status==="pending");
    const sum=list=>Number(list.reduce((s,r)=>s+r.amount,0).toFixed(2));
    const parts=[`${ok.length} successful`,`${bad.length} failed`];if(pend.length)parts.push(`${pend.length} pending`);
    const message=`Bulk airtime processed: ${parts.join(", ")}`;
    try{await addNotificationOnce(userId,"Bulk airtime processed",`${network} airtime of \u20A6${amount.toLocaleString("en-NG")} \u2014 ${parts.join(", ")}. Failed numbers are refunded to your wallet.`,"transaction",`bulk-${batchId}`);}catch(e){console.error("BULK AIRTIME NOTIFICATION ERROR:",e?.message);}
    const wallet=await getWallet(userId);
    return{success:ok.length>0||pend.length>0,statusCode:(ok.length>0||pend.length>0)?200:400,message:ok.length||pend.length?message:"None of the numbers could be recharged. You were not charged.",batchId,balance:Number(wallet?.balance??0),data:{network,total_requested:phones.length,total_successful:ok.length,total_failed:bad.length,total_pending:pend.length,successful_amount:sum(ok),failed_amount:sum(bad),pending_amount:sum(pend),results}};
  }finally{bulkAirtimeInFlight.delete(userId);}
}

/* ===================== INTERNATIONAL TOP-UP (VTUGATE /api/v1/international/*) =====================
   Catalogue calls (countries, operators, detect) are proxied + cached so the 60/min provider limit
   is not burned by page loads. Prices are wholesale in NGN from VTUGATE's fxrate endpoint; BOLTIV adds
   the admin-set markup % + service fee for the "international" service. The price is re-quoted
   server-side at purchase time and the customer is asked to confirm if it has risen. */
const intlCache={countries:{at:0,data:null},operators:new Map(),fx:new Map()};
const INTL_CATALOG_TTL=6*60*60*1000,INTL_OPERATOR_TTL=10*60*1000,INTL_FX_TTL=30*1000;
const intlRequest=(endpoint,payload={},opts={})=>vtugateRequest("api/v1/international/"+endpoint,payload,opts);
const intlMsg=r=>clean(r?.data?.message||r?.message)||"Request failed.";
async function getIntlCountries(){
  if(intlCache.countries.data&&Date.now()-intlCache.countries.at<INTL_CATALOG_TTL)return intlCache.countries.data;
  const r=await intlRequest("countries",{});
  if(!r.success||!Array.isArray(r.data?.data))throw new Error(intlMsg(r));
  const list=r.data.data.map(c=>({isoName:clean(c.isoName).toUpperCase(),name:clean(c.name),flag:clean(c.flag),currencyCode:clean(c.currencyCode),callingCodes:(Array.isArray(c.callingCodes)?c.callingCodes:[]).map(x=>String(x).replace(/\D/g,"")).filter(Boolean)})).filter(c=>c.isoName&&c.name).sort((a,b)=>a.name.localeCompare(b.name));
  intlCache.countries={at:Date.now(),data:list};
  return list;
}
async function intlCountry(iso){const list=await getIntlCountries();return list.find(c=>c.isoName===String(iso||"").toUpperCase())||null;}
function normalizeIntlPhone(raw,country){
  let d=String(raw||"").replace(/\D/g,"");
  if(d.startsWith("00"))d=d.slice(2);
  const cc=country?.callingCodes?.[0]||"";
  if(cc&&!(d.startsWith(cc)&&d.length>=cc.length+6))d=cc+d.replace(/^0+/,"");
  return d;
}
const round2=n=>Number(Number(n).toFixed(2));
function trimIntlOperator(o){
  const rate=Number(o.fx?.rate||0),type=clean(o.denominationType).toUpperCase();
  const toLocal=v=>rate>0&&Number.isFinite(Number(v))?round2(Number(v)*rate):null;
  return{id:Number(o.operatorId||o.id),name:clean(o.name),data:o.data===true,bundle:o.bundle===true,pin:o.pin===true,denominationType:type,currency:clean(o.destinationCurrencyCode||o.fx?.currencyCode),
    fixed:type==="FIXED"?(Array.isArray(o.localFixedAmounts)?o.localFixedAmounts.map(Number):(Array.isArray(o.fixedAmounts)?o.fixedAmounts.map(toLocal).filter(v=>v!=null):[])):[],
    min:type==="RANGE"?(o.localMinAmount!=null?Number(o.localMinAmount):toLocal(o.minAmount)):null,max:type==="RANGE"?(o.localMaxAmount!=null?Number(o.localMaxAmount):toLocal(o.maxAmount)):null,
    descriptions:o.localFixedAmountsDescriptions&&typeof o.localFixedAmountsDescriptions==="object"?o.localFixedAmountsDescriptions:null,approx:o.localFixedAmounts==null&&o.localMinAmount==null};
}
async function getIntlOperators(countryCode,type){
  const key=countryCode+"|"+(type||"");const c=intlCache.operators.get(key);
  if(c&&Date.now()-c.at<INTL_OPERATOR_TTL)return c.data;
  const payload={country_code:countryCode};if(type==="data")payload.type="data";
  const r=await intlRequest("operators",payload);
  if(!r.success||!Array.isArray(r.data?.data))throw new Error(intlMsg(r));
  let list=r.data.data.map(trimIntlOperator).filter(o=>o.id>0&&o.name);
  if(type!=="data")list=list.filter(o=>!o.data&&!o.bundle);
  intlCache.operators.set(key,{at:Date.now(),data:list});
  return list;
}
async function intlQuote(operatorId,amount,{fresh=false}={}){
  const key=operatorId+"|"+amount;const c=intlCache.fx.get(key);
  if(!fresh&&c&&Date.now()-c.at<INTL_FX_TTL)return c.data;
  const r=await intlRequest("fxrate",{operator_id:operatorId,amount});
  const cost=Number(r.data?.data?.charged_to_user);
  if(!r.success||!(cost>0))throw new Error(intlMsg(r));
  const out={cost,operatorName:clean(r.data.data.operator_name),currency:clean(r.data.data.currency_code)};
  intlCache.fx.set(key,{at:Date.now(),data:out});
  if(intlCache.fx.size>500)intlCache.fx.clear();
  return out;
}
async function intlService(userId){
  const svc=await getService("international");
  if(!svc||svc.enabled===false)return{error:{success:false,statusCode:503,message:"International top-up is currently unavailable."}};
  if(svc.maintenance===true)return{error:{success:false,statusCode:503,message:"International top-up is currently under maintenance."}};
  const agent=await getEffectiveAgentService(userId,"international");
  if(agent.isAgent)return{error:{success:false,statusCode:403,message:"International top-up is not available on Agent accounts yet."}};
  return{svc};
}
const intlPrice=(cost,svc)=>customerPriceFromCost(cost,pricingConfig(svc));
function intlValidateCommon(b){
  const countryCode=clean(b.country_code||b.countryCode).toUpperCase();
  if(!/^[A-Z]{2}$/.test(countryCode))return{error:{success:false,statusCode:400,message:"Choose a country."}};
  return{countryCode};
}
async function intlDetect(user,b){
  const s=await intlService(user.user_id);if(s.error)return s.error;
  const v=intlValidateCommon(b);if(v.error)return v.error;
  try{
    const country=await intlCountry(v.countryCode);if(!country)return{success:false,statusCode:400,message:"Unsupported country."};
    const phone=normalizeIntlPhone(b.phone_number||b.phone,country);
    if(!/^\d{8,15}$/.test(phone))return{success:false,statusCode:400,message:"Enter a valid phone number."};
    const r=await intlRequest("detectoperator",{phone_number:phone,country_code:v.countryCode});
    const d=r.data?.data;
    if(!r.success||!d||!(Number(d.operatorId||d.id)>0))return{success:false,statusCode:422,detectFailed:true,message:"We couldn't detect this number's network. Please choose it from the list."};
    return{success:true,phone,operator:trimIntlOperator({...d,fx:null})};
  }catch(e){console.error("INTL DETECT ERROR:",e.message);return{success:false,statusCode:502,detectFailed:true,message:"We couldn't detect this number's network. Please choose it from the list."};}
}
async function intlQuoteRoute(user,b){
  const s=await intlService(user.user_id);if(s.error)return s.error;
  const operatorId=Number(b.operator_id),amount=Number(b.amount);
  if(!Number.isInteger(operatorId)||operatorId<=0)return{success:false,statusCode:400,message:"Choose an operator."};
  if(!(amount>0)||amount>1000000)return{success:false,statusCode:400,message:"Enter a valid amount."};
  try{const q=await intlQuote(operatorId,amount);const price=intlPrice(q.cost,s.svc);if(!(price>0))throw new Error("price");return{success:true,operatorId,operatorName:q.operatorName,amount,currency:q.currency,price,validForSeconds:60};}
  catch(e){console.error("INTL QUOTE ERROR:",e.message);return{success:false,statusCode:502,message:"Couldn't get a price for this amount right now. Check the amount and try again."};}
}
const intlSafeData=d=>({transaction_id:d?.transaction_id??null,operator_name:d?.operator_name??null,country_code:d?.country_code??null,recipient_number:d?.recipient_number??null,requested_amount:d?.requested_amount??null,requested_amount_currency:d?.requested_amount_currency??null,delivered_amount:d?.delivered_amount??null,delivered_amount_currency:d?.delivered_amount_currency??null,pin_detail:d?.pin_detail??null,provider_status:d?.provider_status??null});
async function processInternationalTopup(user,data){
  const userId=clean(user?.user_id);
  if(!userId)return{success:false,statusCode:401,message:"Unauthorized."};
  const s=await intlService(userId);if(s.error)return s.error;
  const v=intlValidateCommon(data);if(v.error)return v.error;
  const countryCode=v.countryCode,amount=Number(data.amount);
  if(!(amount>0)||amount>1000000)return{success:false,statusCode:400,message:"Enter a valid amount."};
  let country;try{country=await intlCountry(countryCode);}catch(e){return{success:false,statusCode:503,message:"Network not available. Please try again later."};}
  if(!country)return{success:false,statusCode:400,message:"Unsupported country."};
  const phone=normalizeIntlPhone(data.phone_number||data.phone,country);
  if(!/^\d{8,15}$/.test(phone))return{success:false,statusCode:400,message:"Enter a valid phone number."};
  const security=await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`,[userId]);
  if(!security.rows[0]?.transaction_pin_hash)return{success:false,statusCode:400,message:"Please set your Transaction PIN before making a purchase."};
  const suppliedPin=String(data.transactionPin||"");
  if(!/^\d{4}$/.test(suppliedPin)||!verifyPassword(suppliedPin,security.rows[0].transaction_pin_hash))return{success:false,statusCode:400,message:"Incorrect Transaction PIN."};
  let operatorId=Number(data.operator_id);
  if(!Number.isInteger(operatorId)||operatorId<=0){
    if(clean(data.type)==="data")return{success:false,statusCode:400,message:"Choose a data bundle operator."};
    const det=await intlDetect(user,{country_code:countryCode,phone_number:phone});
    if(!det.success)return{success:false,statusCode:400,message:det.message};
    operatorId=det.operator.id;
  }
  let q;try{q=await intlQuote(operatorId,amount,{fresh:true});}catch(e){console.error("INTL PURCHASE QUOTE ERROR:",e.message);return{success:false,statusCode:502,message:"Couldn't confirm the price right now. Please try again."};}
  const price=intlPrice(q.cost,s.svc);
  if(!(price>0))return{success:false,statusCode:400,message:"Unable to price this top-up."};
  const expected=Number(data.expectedPrice);
  if(Number.isFinite(expected)&&expected>0&&price>expected*1.01+0.01)return{success:false,statusCode:409,priceChanged:true,newPrice:price,message:`The price has changed to \u20A6${price.toLocaleString("en-NG",{minimumFractionDigits:2})}. Please confirm to continue.`};
  const ref=reference("BOLTIV-TX");
  const idem=clean(data.idempotencyKey||data.idempotency_key);
  const meta={provider:"vtugate",request:{operator_id:operatorId,country_code:countryCode,amount,recipient_number:phone},
    pricing:{providerCost:q.cost,customerPrice:price,grossProfit:round2(price-q.cost),network:q.operatorName,plan:`${amount} ${q.currency}`},
    international:{country_code:countryCode,country:country.name,operator_id:operatorId,operator_name:q.operatorName,amount,currency_code:q.currency}};
  const reserved=await createVTUTransactionAndDebit({userId,service:"international",amount:price,reference:ref,recipient:phone,idempotencyKey:idem||null,useBonus:data.useBonus===true,metadata:meta});
  if(!reserved.success)return{success:false,statusCode:400,message:reserved.message,balance:0};
  if(reserved.existing){const t=reserved.transaction,w=await getWallet(userId);return{success:t.status==="successful"||t.status==="pending"||t.status==="processing",statusCode:200,message:t.status==="successful"?"Transaction successful.":(t.status==="refunded"?"Transaction failed. Your wallet has been refunded.":"Your transaction is being processed."),reference:t.reference,providerReference:t.provider_reference||null,balance:w?.balance??0,status:t.status==="processing"?"pending":t.status,amountCharged:Number(t.amount)};}
  let pr;
  try{pr=await intlRequest("topup",{operator_id:operatorId,amount,country_code:countryCode,recipient_number:phone},{timeoutMs:Number(process.env.VTUGATE_INTL_TIMEOUT_MS||90000)});}
  catch(e){pr={success:false,outcome:"unknown",statusCode:502,data:{},message:"VTUGATE connection could not be confirmed. Your transaction is being verified."};}
  const pd=pr.data?.data&&typeof pr.data.data==="object"&&!Array.isArray(pr.data.data)?pr.data.data:{};
  const providerReference=pd.transaction_id!=null?String(pd.transaction_id):(pr.providerReference||null);
  // A clean 4xx rejection with no provider transaction id means nothing was sent -> safe to refund.
  const rejected=!pr.success&&pr.outcome==="unknown"&&pr.data?.status===false&&[400,401,403,404,422].includes(pr.statusCode)&&!pd.transaction_id;
  const outcome=rejected?"failed":(pr.outcome||"unknown");
  if(!pr.success)console.error("INTERNATIONAL TOPUP NOT CONFIRMED:",JSON.stringify({operatorId,countryCode,outcome,statusCode:pr.statusCode,message:pr.message,raw:JSON.stringify(pr.data||{}).slice(0,500)}));
  if(pr.success&&pd.charged_to_user!=null&&Number(pd.charged_to_user)>q.cost*1.02)console.error("INTERNATIONAL COST HIGHER THAN QUOTED:",JSON.stringify({reference:ref,quoted:q.cost,charged:pd.charged_to_user}));
  const safe=intlSafeData(pd);
  const finalized=await finalizeVTUTransaction(reserved.transaction.id,outcome,safe,providerReference);
  const wallet=await getWallet(userId);
  if(finalized.status==="refunded")return{success:false,statusCode:pr.statusCode>=500?502:400,message:(()=>{const m=clean(pr.data?.message||pr.message);return m&&!/insufficient|balance|wallet|fund|credit|api key|unauthor/i.test(m)?m+(/refund/i.test(m)?"":". Your wallet has been refunded."):"The top-up could not be completed. Your wallet has been refunded.";})(),reference:reserved.transaction.reference,balance:wallet?.balance??0,status:"refunded"};
  return{success:true,statusCode:200,message:finalized.status==="pending"?"Your top-up is being processed. We'll confirm it shortly \u2014 check your Activity page.":"International top-up was successful.",reference:reserved.transaction.reference,providerReference,balance:wallet?.balance??reserved.balance,status:finalized.status,amountCharged:price,delivered:{amount:pd.delivered_amount??null,currency:pd.delivered_amount_currency??null},operatorName:q.operatorName,country:country.name,pin:pd.pin_detail??null};
}

/* ===================== SMS (VTUGATE sendsms / sendbulksms / registersenderid) =====================
   One BOLTIV transaction per send request (single or bulk). The wallet is debited up front using
   the route's per-page price from VTUGATE's catalogue plus BOLTIV's markup; on a bulk send the
   share belonging to numbers that explicitly failed is refunded to the wallet. Sender IDs are
   registered on BOLTIV's VTUGATE account, so customer requests are reviewed by an admin first. */
const SMS_MAX_RECIPIENTS=1000,SMS_MAX_CHARS=765;
const SMS_DAILY_RECIPIENT_CAP=Number(process.env.SMS_DAILY_RECIPIENT_CAP||2000);
const smsRouteCache={at:0,data:[]};
let smsSenderSyncAt=0;
const SMS_GSM_BASIC="@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const SMS_GSM_EXT="^{}\\[~]|€";
function smsAnalyze(message){
  let gsmLen=0,gsm=true;
  for(const ch of String(message)){
    if(SMS_GSM_BASIC.includes(ch))gsmLen+=1;
    else if(SMS_GSM_EXT.includes(ch))gsmLen+=2;
    else{gsm=false;break;}
  }
  const characters=gsm?gsmLen:String(message).length;
  const single=gsm?160:70,multi=gsm?153:67;
  const pages=characters<=single?1:Math.ceil(characters/multi);
  return{encoding:gsm?"gsm":"unicode",characters,pages};
}
function smsRouteFromRow(row){
  const id=Number(row?.service_id??row?.serviceId??row?.id);
  const label=clean(row?.route_type||row?.route||row?.label||row?.name||row?.service_name||"SMS");
  let unit=null;
  for(const k of ["price","unit_price","amount","cost","rate","sms_price","price_per_page","charge","vendor_price"]){const n=Number(row?.[k]);if(Number.isFinite(n)&&n>0){unit=n;break;}}
  return{service_id:id,label,unit,dnd:/dnd/i.test(label+" "+clean(row?.description))};
}
async function getSmsRoutes(){
  if(smsRouteCache.data.length&&Date.now()-smsRouteCache.at<300000)return smsRouteCache.data;
  const pull=r=>Array.isArray(r.data?.data)?r.data.data:(Array.isArray(r.data?.services)?r.data.services:[]);
  let rows=[];
  const a=await vtugateRequest("api/v1/fetchservices",{service_type:"sms"});
  if(a.success)rows=pull(a).filter(x=>{const t=clean(x.service_type).toLowerCase();return !t||t==="sms";});
  if(!rows.length){const b=await fetchVTUGATEServices(true);if(!b.success)throw new Error(b.message||"Unable to load SMS routes.");rows=pull(b).filter(x=>clean(x.service_type).toLowerCase()==="sms");}
  if(rows.length)console.log("SMS ROUTE CATALOGUE SAMPLE ROW:",JSON.stringify(rows[0]).slice(0,600));
  const routes=rows.map(smsRouteFromRow).filter(r=>r.service_id>0&&r.unit>0);
  if(rows.length&&!routes.length)console.error("SMS ROUTES FOUND BUT NO PRICE FIELD RECOGNISED. Row keys:",Object.keys(rows[0]||{}).join(","));
  smsRouteCache.at=Date.now();smsRouteCache.data=routes;
  return routes;
}
async function smsService(){
  const svc=await getService("sms");
  if(!svc||svc.enabled===false)return{error:{success:false,statusCode:503,message:"SMS is currently unavailable."}};
  if(svc.maintenance===true)return{error:{success:false,statusCode:503,message:"SMS is currently under maintenance."}};
  return{svc};
}
const smsPrice=(cost,svc)=>customerPriceFromCost(cost,pricingConfig(svc));
function smsPriceFor(route,pages,recipients,svc){
  const cost=Number((route.unit*pages*recipients).toFixed(4));
  return{cost,price:smsPrice(cost,svc)};
}
async function smsSyncSenderIds(force=false){
  if(!force&&Date.now()-smsSenderSyncAt<10*60*1000)return;
  smsSenderSyncAt=Date.now();
  const pending=await db(`SELECT 1 FROM sms_sender_ids WHERE status='pending' LIMIT 1`);
  if(!pending.rows.length)return;
  const r=await vtugateRequest("api/v1/listsenderids",{});
  const list=Array.isArray(r.data?.data)?r.data.data:null;
  if(r.data?.status!==true||!list)return;
  for(const x of list){
    const st=clean(x.status).toLowerCase();
    if(!["approved","rejected","pending"].includes(st))continue;
    await db(`UPDATE sms_sender_ids SET status=$1,notes=COALESCE($2,notes),updated_at=NOW() WHERE status IN ('pending','approved','rejected') AND (provider_id=$3 OR sender_id=$4) AND status<>$1`,[st,x.notes||null,Number(x.id)||null,clean(x.sender_id)]);
  }
}
function validateSenderIdRequest(b){
  const sender=clean(b.sender_id);
  if(!/^[A-Za-z0-9]{1,11}$/.test(sender))return{error:"Sender ID must be 1-11 letters or numbers, with no spaces or symbols."};
  const f={company_name:clean(b.company_name),company_website:clean(b.company_website),nature_of_business:clean(b.nature_of_business),sample_sms:clean(b.sample_sms),sms_type:clean(b.sms_type).toLowerCase(),phone_number:clean(b.phone_number),purpose:clean(b.purpose)};
  for(const [k,v] of Object.entries(f))if(!v)return{error:`Please fill in ${k.replace(/_/g," ")}.`};
  if(!["transactional","corporate","marketing"].includes(f.sms_type))return{error:"Choose a valid SMS type."};
  if(!/^0\d{10}$/.test(f.phone_number))return{error:"Enter a valid 11-digit phone number."};
  if(!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(f.company_website))return{error:"Enter a valid company website (starting with https://)."};
  if(f.sample_sms.length>300||f.purpose.length>300||f.company_name.length>120||f.nature_of_business.length>120)return{error:"One of the fields is too long."};
  return{sender,details:f};
}
async function smsRequestSenderId(user,b){
  const v=validateSenderIdRequest(b);if(v.error)return{success:false,statusCode:400,message:v.error};
  const dup=await db(`SELECT user_id,status FROM sms_sender_ids WHERE sender_id=$1 AND status<>'rejected' LIMIT 1`,[v.sender]);
  if(dup.rows.length)return{success:false,statusCode:409,message:"This sender ID is already registered or requested. Please choose another."};
  const mine=await db(`SELECT COUNT(*)::int c FROM sms_sender_ids WHERE user_id=$1 AND status IN ('requested','pending')`,[user.user_id]);
  if(mine.rows[0].c>=3)return{success:false,statusCode:400,message:"You already have 3 sender IDs awaiting approval. Please wait for them to be reviewed."};
  await db(`INSERT INTO sms_sender_ids(user_id,sender_id,status,details) VALUES($1,$2,'requested',$3::jsonb)`,[user.user_id,v.sender,JSON.stringify(v.details)]);
  return{success:true,message:"Sender ID request received. We'll review it and submit it for approval \u2014 this usually takes 1-3 days."};
}
async function smsConfig(user){
  const s=await smsService();if(s.error)return s.error;
  try{await smsSyncSenderIds();}catch(e){console.error("SMS SENDER SYNC ERROR:",e.message);}
  let routes=[];try{routes=await getSmsRoutes();}catch(e){console.error("SMS ROUTES ERROR:",e.message);}
  const ids=await db(`SELECT id,sender_id,status,notes,user_id,created_at FROM sms_sender_ids WHERE user_id IS NULL OR user_id=$1 ORDER BY created_at DESC LIMIT 100`,[user.user_id]);
  return{success:true,maxRecipients:SMS_MAX_RECIPIENTS,maxChars:SMS_MAX_CHARS,
    routes:routes.map(r=>({service_id:r.service_id,label:r.label,dnd:r.dnd,unitPrice:smsPrice(r.unit,s.svc)})),
    senderIds:ids.rows.map(x=>({id:Number(x.id),sender_id:x.sender_id,status:x.status,notes:x.status==="rejected"?(x.notes||null):null,mine:x.user_id!=null,sendable:x.status==="approved"}))};
}
async function smsPrepare(user,b){
  const s=await smsService();if(s.error)return{error:s.error};
  const message=String(b.message??"");
  if(!message.trim())return{error:{success:false,statusCode:400,message:"Enter your message."}};
  if(message.length>SMS_MAX_CHARS)return{error:{success:false,statusCode:400,message:`Message is too long (max ${SMS_MAX_CHARS} characters).`}};
  const an=smsAnalyze(message);
  if(an.pages>5)return{error:{success:false,statusCode:400,message:"Message is too long for its character set (max 5 pages). Remove emoji or accented characters, or shorten it."}};
  const phones=parseBulkPhones(b.recipients??b.recipient);
  if(!phones.length)return{error:{success:false,statusCode:400,message:"Add at least one recipient."}};
  const invalid=phones.filter(p=>!/^0\d{10}$/.test(p));
  if(invalid.length)return{error:{success:false,statusCode:400,message:`${invalid.length} number${invalid.length>1?"s are":" is"} not valid. Fix or remove ${invalid.length>1?"them":"it"} and try again.`,invalidNumbers:invalid.slice(0,20)}};
  if(phones.length>SMS_MAX_RECIPIENTS)return{error:{success:false,statusCode:400,message:`You can send to up to ${SMS_MAX_RECIPIENTS} numbers at a time.`}};
  let routes;try{routes=await getSmsRoutes();}catch(e){console.error("SMS ROUTES ERROR:",e.message);return{error:{success:false,statusCode:503,message:"SMS is not available right now. Please try again later."}};}
  const route=routes.find(r=>r.service_id===Number(b.service_id));
  if(!route)return{error:{success:false,statusCode:400,message:"Choose a sending route."}};
  const pr=smsPriceFor(route,an.pages,phones.length,s.svc);
  if(!(pr.price>0))return{error:{success:false,statusCode:400,message:"Unable to price this message."}};
  return{svc:s.svc,message,an,phones,route,cost:pr.cost,price:pr.price};
}
async function smsQuote(user,b){
  const p=await smsPrepare(user,b);if(p.error)return p.error;
  return{success:true,pages:p.an.pages,characters:p.an.characters,encoding:p.an.encoding,recipients:p.phones.length,total:p.price};
}
// Refund part of a processing transaction (numbers that explicitly failed) before it is finalised as successful.
async function smsPartialRefund(txId,refundAmount,failedPhones){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const q=await client.query(`SELECT * FROM transactions WHERE id=$1 FOR UPDATE`,[txId]);
    const tx=q.rows[0];
    if(!tx||tx.status!=="processing"||tx.refunded_at){await client.query("ROLLBACK");return false;}
    const amt=Math.min(Number(refundAmount),Number(tx.amount));
    if(!(amt>0)){await client.query("ROLLBACK");return false;}
    const wr=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[amt,tx.user_id]);
    if(!wr.rows.length)throw new Error("Wallet could not be credited for partial refund.");
    await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:tx.user_id,direction:"credit",amount:amt,balanceAfter:Number(wr.rows[0].balance),reference:`WALLET-PARTIAL-REFUND-${tx.reference}`,transactionId:tx.id,category:"vtu_refund",description:"Partial refund for SMS",metadata:{failed_count:failedPhones.length}});
    const meta=tx.metadata&&typeof tx.metadata==="object"?tx.metadata:{};
    const newAmount=Number((Number(tx.amount)-amt).toFixed(2));
    const ratio=Number(tx.amount)>0?newAmount/Number(tx.amount):1;
    const pricing=meta.pricing&&typeof meta.pricing==="object"?{...meta.pricing}:{};
    if(pricing.providerCost!=null)pricing.providerCost=Number((Number(pricing.providerCost)*ratio).toFixed(2));
    pricing.customerPrice=newAmount;pricing.grossProfit=pricing.providerCost!=null?Number((newAmount-pricing.providerCost).toFixed(2)):0;
    await client.query(`UPDATE transactions SET amount=$2,metadata=$3::jsonb WHERE id=$1`,[txId,newAmount,JSON.stringify({...meta,pricing,partial_refund:{amount:amt,failed_count:failedPhones.length,failed:failedPhones.slice(0,200)}})]);
    await client.query("COMMIT");
    return true;
  }catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}
async function processSendSms(user,data){
  const userId=clean(user?.user_id);
  if(!userId)return{success:false,statusCode:401,message:"Unauthorized."};
  const p=await smsPrepare(user,data);if(p.error)return p.error;
  const sid=await db(`SELECT sender_id FROM sms_sender_ids WHERE sender_id=$1 AND status='approved' AND (user_id IS NULL OR user_id=$2) LIMIT 1`,[clean(data.sender_id),userId]);
  if(!sid.rows.length)return{success:false,statusCode:400,message:"Choose an approved sender ID."};
  const senderId=sid.rows[0].sender_id;
  const security=await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`,[userId]);
  if(!security.rows[0]?.transaction_pin_hash)return{success:false,statusCode:400,message:"Please set your Transaction PIN before making a purchase."};
  const suppliedPin=String(data.transactionPin||"");
  if(!/^\d{4}$/.test(suppliedPin)||!verifyPassword(suppliedPin,security.rows[0].transaction_pin_hash))return{success:false,statusCode:400,message:"Incorrect Transaction PIN."};
  const used=await db(`SELECT COALESCE(SUM((metadata->'sms'->>'recipients')::int),0)::int n FROM transactions WHERE user_id=$1 AND service='sms' AND status IN ('processing','pending','successful') AND date>NOW()-INTERVAL '24 hours'`,[userId]);
  if(used.rows[0].n+p.phones.length>SMS_DAILY_RECIPIENT_CAP)return{success:false,statusCode:429,message:`Daily SMS limit reached (${SMS_DAILY_RECIPIENT_CAP} recipients per 24 hours). Please try again later.`};
  const bulk=p.phones.length>1;
  const ref=reference("BOLTIV-TX");
  const idem=clean(data.idempotencyKey||data.idempotency_key);
  const meta={provider:"vtugate",request:{service_id:p.route.service_id,sender_id:senderId,recipients:p.phones.length},
    pricing:{providerCost:Number(p.cost.toFixed(2)),customerPrice:p.price,grossProfit:Number((p.price-p.cost).toFixed(2)),network:p.route.label,plan:`${p.an.pages} page${p.an.pages>1?"s":""}`},
    sms:{sender_id:senderId,route:p.route.label,pages:p.an.pages,encoding:p.an.encoding,characters:p.an.characters,recipients:p.phones.length,message:p.message,numbers:bulk?undefined:p.phones[0]}};
  const reserved=await createVTUTransactionAndDebit({userId,service:"sms",amount:p.price,reference:ref,recipient:bulk?`${p.phones.length} recipients`:p.phones[0],idempotencyKey:idem||null,useBonus:false,metadata:meta});
  if(!reserved.success)return{success:false,statusCode:400,message:reserved.message,balance:0};
  if(reserved.existing){const t=reserved.transaction,w=await getWallet(userId);return{success:t.status==="successful"||t.status==="pending"||t.status==="processing",statusCode:200,message:t.status==="successful"?"SMS sent.":(t.status==="refunded"?"SMS could not be sent. Your wallet has been refunded.":"Your SMS is being processed."),reference:t.reference,balance:w?.balance??0,status:t.status==="processing"?"pending":t.status,amountCharged:Number(t.amount)};}
  let pr;
  try{pr=bulk
    ?await vtugateRequest("api/v1/sendbulksms",{sender_id:senderId,recipient:p.phones.join(","),message:p.message,service_id:p.route.service_id},{timeoutMs:Number(process.env.VTUGATE_BULK_SMS_TIMEOUT_MS||180000)})
    :await vtugateRequest("api/v1/sendsms",{sender_id:senderId,recipient:p.phones[0],message:p.message,service_id:p.route.service_id},{timeoutMs:60000});}
  catch(e){pr={success:false,outcome:"unknown",statusCode:502,data:{},message:"VTUGATE connection could not be confirmed."};}
  const pd=pr.data?.data&&typeof pr.data.data==="object"&&!Array.isArray(pr.data.data)?pr.data.data:{};
  const rows=Array.isArray(pd.results)?pd.results:[];
  const providerReference=!bulk&&pd.transaction_id!=null?String(pd.transaction_id):null;
  const rejected=!pr.success&&pr.outcome==="unknown"&&pr.data?.status===false&&[400,401,403,404,422].includes(pr.statusCode)&&!pd.transaction_id&&!rows.length;
  if(!pr.success&&!rows.length)console.error("SMS SEND NOT CONFIRMED:",JSON.stringify({bulk,outcome:pr.outcome,statusCode:pr.statusCode,message:pr.message,raw:JSON.stringify(pr.data||{}).slice(0,500)}));
  let outcome,sent=0,failedPhones=[];
  if(!bulk){
    outcome=rejected?"failed":(pr.outcome||"unknown");
    if(pr.success&&pd.charged_to_user!=null&&Number(pd.charged_to_user)>p.cost*1.05)console.error("SMS COST HIGHER THAN ESTIMATE:",JSON.stringify({reference:ref,estimatedCost:p.cost,charged:pd.charged_to_user}));
    sent=outcome==="successful"?1:0;
  }else if(rejected){outcome="failed";}
  else if(!rows.length){outcome=pr.success?"pending":(pr.outcome||"unknown");}
  else{
    const key=x=>bulkPhoneKey(x);
    const state=new Map();
    for(const r of rows){const st=String(r.status||"").trim().toLowerCase();state.set(key(r.recipient),/^(success|successful|sent|delivered)$/.test(st)?"ok":(/(fail|error|reject|invalid|insufficient|cancel)/.test(st)?"fail":"unknown"));}
    for(const ph of p.phones){const st=state.get(key(ph))||"unknown";if(st==="ok")sent++;else if(st==="fail")failedPhones.push(ph);}
    if(Number(pd.total_charged)>p.price*1.05)console.error("BULK SMS CHARGED MORE THAN ESTIMATE:",JSON.stringify({reference:ref,estimatedCost:p.cost,totalCost:pd.total_cost,totalCharged:pd.total_charged}));
    if(failedPhones.length===p.phones.length)outcome="failed";
    else{
      outcome="successful";
      if(failedPhones.length){
        const refund=Number((p.price-p.price*(p.phones.length-failedPhones.length)/p.phones.length).toFixed(2));
        try{await smsPartialRefund(reserved.transaction.id,refund,failedPhones);}catch(e){console.error("SMS PARTIAL REFUND ERROR:",JSON.stringify({reference:ref,error:e?.message}));}
      }
    }
  }
  const safe={sender_id:senderId,message_pages:pd.message_pages??null,encoding:pd.encoding??null,total_requested:pd.total_requested??null,total_successful:pd.total_successful??null,total_failed:pd.total_failed??null,provider_status:pd.provider_status??null};
  const finalized=await finalizeVTUTransaction(reserved.transaction.id,outcome,safe,providerReference);
  const wallet=await getWallet(userId);
  if(finalized.status==="refunded")return{success:false,statusCode:pr.statusCode>=500?502:400,message:(()=>{const m=clean(pr.data?.message||pr.message);return m&&!/insufficient|balance|wallet|fund|credit|api key|unauthor/i.test(m)?m+(/refund/i.test(m)?"":". Your wallet has been refunded."):"Your SMS could not be sent. Your wallet has been refunded.";})(),reference:reserved.transaction.reference,balance:wallet?.balance??0,status:"refunded"};
  const total=p.phones.length;
  return{success:true,statusCode:200,message:finalized.status==="pending"?"Your SMS is being processed. We'll confirm it shortly \u2014 check your Activity page.":(bulk?`Bulk SMS processed: ${sent} sent, ${failedPhones.length} failed`:"SMS sent successfully."),reference:reserved.transaction.reference,providerReference,balance:wallet?.balance??reserved.balance,status:finalized.status,recipients:total,sent:finalized.status==="pending"?null:sent,failed:failedPhones.length,failedNumbers:failedPhones.slice(0,200),pages:p.an.pages,amountCharged:Number((p.price-(failedPhones.length?Number((p.price-p.price*(total-failedPhones.length)/total).toFixed(2)):0)).toFixed(2))};
}
/* ----- admin: sender ID review ----- */
async function adminSmsSenderIds(req,path,b){
  const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(req.method==="GET"){
    try{await smsSyncSenderIds(true);}catch(e){console.error("SMS SENDER SYNC ERROR:",e.message);}
    const r=await db(`SELECT s.id,s.sender_id,s.status,s.notes,s.details,s.user_id,s.created_at,u.name,u.email FROM sms_sender_ids s LEFT JOIN users u ON u.user_id=s.user_id ORDER BY (s.status='requested') DESC,s.created_at DESC LIMIT 300`);
    return{success:true,senderIds:r.rows};
  }
  if(path==="/api/admin/sms/sender-ids/sync"){try{await smsSyncSenderIds(true);}catch(e){return{success:false,statusCode:502,message:"Sync failed."};}return{success:true};}
  const submitNew=async(row)=>{
    const d=row.details||{};
    const r=await vtugateRequest("api/v1/registersenderid",{sender_id:row.sender_id,company_name:d.company_name,company_website:d.company_website,nature_of_business:d.nature_of_business,sample_sms:d.sample_sms,sms_type:d.sms_type,phone_number:d.phone_number,purpose:d.purpose});
    if(r.data?.status!==true)return{success:false,statusCode:400,message:clean(r.data?.message||r.message)||"VTUGATE rejected the request."};
    const pid=Number(r.data?.data?.id)||null;
    await db(`UPDATE sms_sender_ids SET status='pending',provider_id=$2,updated_at=NOW() WHERE id=$1`,[row.id,pid]);
    return{success:true,message:clean(r.data?.message)||"Submitted for approval."};
  };
  if(path==="/api/admin/sms/sender-ids"&&req.method==="POST"){
    const v=validateSenderIdRequest(b);if(v.error)return{success:false,statusCode:400,message:v.error};
    const dup=await db(`SELECT 1 FROM sms_sender_ids WHERE sender_id=$1 AND status<>'rejected' LIMIT 1`,[v.sender]);
    if(dup.rows.length)return{success:false,statusCode:409,message:"This sender ID is already registered or requested."};
    const ins=await db(`INSERT INTO sms_sender_ids(user_id,sender_id,status,details) VALUES(NULL,$1,'requested',$2::jsonb) RETURNING id,sender_id,details`,[v.sender,JSON.stringify(v.details)]);
    return submitNew(ins.rows[0]);
  }
  const m=path.match(/^\/api\/admin\/sms\/sender-ids\/(\d+)\/(submit|reject)$/);
  if(m&&req.method==="POST"){
    const row=(await db(`SELECT id,sender_id,details,status,user_id FROM sms_sender_ids WHERE id=$1 LIMIT 1`,[Number(m[1])])).rows[0];
    if(!row)return{success:false,statusCode:404,message:"Not found."};
    if(row.status!=="requested")return{success:false,statusCode:400,message:"Only requested sender IDs can be reviewed."};
    if(m[2]==="reject"){
      const notes=clean(b.notes).slice(0,300)||"Not approved.";
      await db(`UPDATE sms_sender_ids SET status='rejected',notes=$2,updated_at=NOW() WHERE id=$1`,[row.id,notes]);
      if(row.user_id){try{await addNotificationOnce(row.user_id,"Sender ID not approved",`Your sender ID "${row.sender_id}" was not approved: ${notes}`,"info",`smsid-reject-${row.id}`);}catch{}}
      return{success:true};
    }
    const res=await submitNew(row);
    if(res.success&&row.user_id){try{await addNotificationOnce(row.user_id,"Sender ID submitted",`Your sender ID "${row.sender_id}" was submitted for approval. This usually takes 24-72 hours.`,"info",`smsid-submit-${row.id}`);}catch{}}
    return res;
  }
  return{success:false,statusCode:404,message:"Not found."};
}

async function verifyVTUGATECable(req,user){const b=await body(req);const providerName=clean(b.provider).toUpperCase();let serviceId;try{serviceId=await getVTUGATEServiceId("cable",providerName);}catch(e){console.error("VTUGATE unavailable (Unable to verify the cable TV service for this provider right now.):",e.message);return{success:false,statusCode:503,message:"Network not available. Please try again later."};}const iucnumber=clean(b.smartcard||b.iucnumber);if(!/^\d{8,20}$/.test(iucnumber))return{success:false,statusCode:400,message:"Invalid smartcard/IUC number."};const phoneVal=clean(b.phone||"08000000000");const result=await vtugateRequest("api/v1/verifycabletv",{service_id:serviceId,provider:providerName,iucnumber,smartcard:iucnumber,phone:phoneVal,phone_number:phoneVal,msisdn:phoneVal});
if(!result.success||!user)return result;
const agentService=await getEffectiveAgentService(user.user_id,"cable");
const cablePricingRow=agentService.isAgent?await getAgentPricingRow("cable"):null;
const agentPricing=(agentService.isAgent&&cablePricingRow&&cablePricingRow.active!==false)?agentPricingConfig(cablePricingRow,agentService.markupOverride):null;
const providerPlans=CABLE_PLANS[providerName]||{};
const plans={};
for(const [planName,price] of Object.entries(providerPlans)){
plans[planName]={customer_price:Number(price),agent_price:agentPricing?customerPriceFromCost(price,agentPricing):null};
}
return{...result,plans,isAgent:agentService.isAgent,agentEnabled:agentService.enabled};}
async function verifyVTUGATEElectricity(req){const b=await body(req);const discoAbbrev=clean(b.provider||b.disco).toLowerCase();if(!discoAbbrev)return{success:false,statusCode:400,message:"Electricity provider is required."};let serviceId,disco;try{({serviceId,disco}=await resolveElectricityDisco(discoAbbrev));}catch(e){console.error("VTUGATE unavailable (Unable to verify the electricity service right now.):",e.message);return{success:false,statusCode:503,message:"Network not available. Please try again later."};}const meterNo=clean(b.meterNumber||b.meter_no||b.meternumber);if(meterNo.length<8)return{success:false,statusCode:400,message:"Invalid meter number."};const result=await vtugateRequest("api/v1/verifyelectricity",{service_id:serviceId,meter_no:meterNo,disco});if(!result.success)return result;const customerName=findTransactionField(result.data,["meter_name","customer_name","name"]);const address=findTransactionField(result.data,["cust_address","address"]);return{...result,customerName,address};}

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
let bonusUsed=0;
if(data.useBonus===true){bonusUsed=await spendBonusTx(client,{userId:data.userId,reference:data.reference,maxAmount:data.amount});}
const walletDebit=Number((Number(data.amount)-bonusUsed).toFixed(2));
const wallet=await client.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`,[walletDebit,data.userId]);
if(!wallet.rows.length){await client.query("ROLLBACK");return {success:false,message:"Insufficient wallet balance."};}
await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:data.userId,direction:"debit",amount:-walletDebit,balanceAfter:Number(wallet.rows[0].balance),reference:`WALLET-DEBIT-${data.reference}`,category:"vtu_debit",description:`Wallet debit for ${data.service}`,metadata:{service:data.service,recipient:data.recipient||null}});
let inserted;
try{
inserted=await client.query(`INSERT INTO transactions(user_id,type,service,amount,reference,status,recipient,metadata,idempotency_key,provider_reference) VALUES($1,'debit',$2,$3,$4,'processing',$5,$6::jsonb,$7,$8) RETURNING id,reference,status,amount,provider_reference`,[data.userId,data.service,data.amount,data.reference,data.recipient||null,JSON.stringify(bonusUsed>0?{...(data.metadata||{}),bonus:{used:bonusUsed,wallet_paid:walletDebit}}:(data.metadata||{})),data.idempotencyKey||null,data.providerReference||null]);
await client.query(`UPDATE financial_ledger SET transaction_id=$1 WHERE reference=$2`,[inserted.rows[0].id,`WALLET-DEBIT-${data.reference}`]);
}catch(e){
if(e.code==="23505"&&data.idempotencyKey){const existing=await client.query(`SELECT id,reference,status,amount,provider_reference FROM transactions WHERE user_id=$1 AND idempotency_key=$2 LIMIT 1 FOR UPDATE`,[data.userId,data.idempotencyKey]);if(existing.rows.length){await client.query("ROLLBACK");return {success:true,existing:true,transaction:existing.rows[0]};}}
throw e;
}
await client.query("COMMIT");
return {success:true,existing:false,transaction:inserted.rows[0],balance:Number(wallet.rows[0].balance)};
}catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}finally{client.release();}
}

/* ===================== BOLTIV BONUS / CASHBACK =====================
   Cashback is earned on successful DATA purchases only, lands in a separate bonus balance
   (lots, each with its own 90-day expiry), can pay any part of any purchase, and is never
   withdrawable. All bonus code is isolated: a bonus failure must never break a purchase. */
const BONUS_EXPIRY_DAYS=90;
const BONUS_MAX_CASHBACK=200;
const toKobo=n=>Math.round(Number(n||0)*100);
const fromKobo=k=>Number((k/100).toFixed(2));
function cashbackForAmount(amount){
  const a=Number(amount);
  if(!Number.isFinite(a)||a<100)return 0;
  const rate=a>1000?0.02:0.01;
  return Math.min(fromKobo(Math.round(a*rate*100)),BONUS_MAX_CASHBACK);
}
async function cashbackEnabled(){
  const v=await getPlatformSetting("cashback_enabled",true);
  return v!==false&&v!=="false";
}
async function bonusAvailableFor(client,userId){
  const r=await client.query(`SELECT COALESCE(SUM(remaining),0) AS total FROM bonus_lots WHERE user_id=$1 AND status='active' AND remaining>0 AND expires_at>NOW()`,[String(userId)]);
  return Number(r.rows[0]?.total||0);
}
async function spendBonusTx(client,{userId,reference,maxAmount}){
  const lots=await client.query(`SELECT id,remaining FROM bonus_lots WHERE user_id=$1 AND status='active' AND remaining>0 AND expires_at>NOW() ORDER BY expires_at ASC,id ASC FOR UPDATE`,[String(userId)]);
  let need=toKobo(maxAmount),used=0;
  for(const lot of lots.rows){
    if(need<=0)break;
    const have=toKobo(lot.remaining),take=Math.min(have,need);
    if(take<=0)continue;
    await client.query(`UPDATE bonus_lots SET remaining=remaining-$1,status=CASE WHEN remaining-$1<=0 THEN 'used' ELSE 'active' END,updated_at=NOW() WHERE id=$2`,[fromKobo(take),lot.id]);
    await client.query(`INSERT INTO bonus_spends(lot_id,user_id,transaction_reference,amount) VALUES($1,$2,$3,$4)`,[lot.id,String(userId),String(reference),fromKobo(take)]);
    need-=take;used+=take;
  }
  if(used>0){
    const after=await bonusAvailableFor(client,userId);
    await addFinancialLedger(client,{accountType:"customer_bonus",ownerId:userId,direction:"debit",amount:-fromKobo(used),balanceAfter:after,reference:`BONUS-SPEND-${reference}`,category:"bonus_spend",description:"Bonus used for purchase",metadata:{transaction_reference:reference}});
  }
  return fromKobo(used);
}
async function restoreBonusForTx(client,tx){
  const meta=tx.metadata&&typeof tx.metadata==="object"?tx.metadata:{};
  if(!(Number(meta.bonus?.used)>0))return 0;
  const spends=await client.query(`SELECT id,lot_id,amount FROM bonus_spends WHERE transaction_reference=$1 AND restored=FALSE FOR UPDATE`,[String(tx.reference)]);
  let total=0;
  for(const sp of spends.rows){
    await client.query(`UPDATE bonus_lots SET remaining=remaining+$1,status='active',expires_at=GREATEST(expires_at,NOW()+INTERVAL '7 days'),updated_at=NOW() WHERE id=$2`,[sp.amount,sp.lot_id]);
    await client.query(`UPDATE bonus_spends SET restored=TRUE WHERE id=$1`,[sp.id]);
    total+=toKobo(sp.amount);
  }
  if(total>0){
    const after=await bonusAvailableFor(client,tx.user_id);
    await addFinancialLedger(client,{accountType:"customer_bonus",ownerId:tx.user_id,direction:"credit",amount:fromKobo(total),balanceAfter:after,reference:`BONUS-RESTORE-${tx.reference}`,transactionId:tx.id,category:"bonus_restore",description:"Bonus returned after refund",metadata:{transaction_reference:tx.reference}});
  }
  return fromKobo(total);
}
// Never throws and never poisons the surrounding DB transaction (SAVEPOINT).
async function awardCashbackTx(client,tx){
  try{
    if(String(tx.service||"").toLowerCase()!=="data")return 0;
    const meta=tx.metadata&&typeof tx.metadata==="object"?tx.metadata:{};
    if(meta.pricing&&meta.pricing.agentPrice!=null)return 0; // agent wholesale sales earn no cashback
    if(!(await cashbackEnabled()))return 0;
    const amount=cashbackForAmount(tx.amount);
    if(!(amount>0))return 0;
    await client.query("SAVEPOINT bonus_award");
    try{
      const ins=await client.query(`INSERT INTO bonus_lots(user_id,source_reference,transaction_reference,amount,remaining,expires_at) VALUES($1,$2,$3,$4::numeric,$4::numeric,NOW()+INTERVAL '${BONUS_EXPIRY_DAYS} days') ON CONFLICT(source_reference) DO NOTHING RETURNING id`,[String(tx.user_id),`CASHBACK-${tx.reference}`,String(tx.reference),amount]);
      if(!ins.rows.length){await client.query("RELEASE SAVEPOINT bonus_award");return 0;}
      const after=await bonusAvailableFor(client,tx.user_id);
      await addFinancialLedger(client,{accountType:"customer_bonus",ownerId:tx.user_id,direction:"credit",amount,balanceAfter:after,reference:`BONUS-EARN-${tx.reference}`,transactionId:tx.id,category:"cashback",description:"Cashback earned on data purchase",metadata:{transaction_reference:tx.reference}});
      await client.query("RELEASE SAVEPOINT bonus_award");
      return amount;
    }catch(error){
      await client.query("ROLLBACK TO SAVEPOINT bonus_award");
      console.error("CASHBACK AWARD ERROR:",error?.stack||error?.message||error);
      return 0;
    }
  }catch(error){console.error("CASHBACK AWARD ERROR:",error?.stack||error?.message||error);return 0;}
}
// Takes back whatever is left of the cashback earned on a purchase that is later refunded.
async function reverseCashbackTx(client,tx){
  try{
    if(String(tx.service||"").toLowerCase()!=="data")return 0;
    await client.query("SAVEPOINT bonus_reverse");
    try{
      const lot=await client.query(`SELECT id,remaining FROM bonus_lots WHERE source_reference=$1 FOR UPDATE`,[`CASHBACK-${tx.reference}`]);
      if(!lot.rows.length||toKobo(lot.rows[0].remaining)<=0){await client.query("RELEASE SAVEPOINT bonus_reverse");return 0;}
      const left=Number(lot.rows[0].remaining);
      await client.query(`UPDATE bonus_lots SET remaining=0,status='reversed',updated_at=NOW() WHERE id=$1`,[lot.rows[0].id]);
      const after=await bonusAvailableFor(client,tx.user_id);
      await addFinancialLedger(client,{accountType:"customer_bonus",ownerId:tx.user_id,direction:"debit",amount:-left,balanceAfter:after,reference:`BONUS-REVERSE-${tx.reference}`,transactionId:tx.id,category:"cashback_reversed",description:"Cashback reversed after refund",metadata:{transaction_reference:tx.reference}});
      await client.query("RELEASE SAVEPOINT bonus_reverse");
      return left;
    }catch(error){
      await client.query("ROLLBACK TO SAVEPOINT bonus_reverse");
      console.error("CASHBACK REVERSE ERROR:",error?.stack||error?.message||error);
      return 0;
    }
  }catch(error){console.error("CASHBACK REVERSE ERROR:",error?.stack||error?.message||error);return 0;}
}
async function expireBonusLots(){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query(`SELECT id,user_id,remaining,source_reference FROM bonus_lots WHERE status='active' AND remaining>0 AND expires_at<=NOW() ORDER BY id ASC LIMIT 500 FOR UPDATE SKIP LOCKED`);
    for(const lot of r.rows){
      await client.query(`UPDATE bonus_lots SET remaining=0,status='expired',updated_at=NOW() WHERE id=$1`,[lot.id]);
      const after=await bonusAvailableFor(client,lot.user_id);
      await addFinancialLedger(client,{accountType:"customer_bonus",ownerId:lot.user_id,direction:"debit",amount:-Number(lot.remaining),balanceAfter:after,reference:`BONUS-EXPIRE-${lot.id}`,category:"bonus_expired",description:"Bonus expired",metadata:{lot_id:lot.id,source_reference:lot.source_reference}});
    }
    await client.query("COMMIT");
    return r.rows.length;
  }catch(error){try{await client.query("ROLLBACK")}catch{};console.error("BONUS EXPIRY ERROR:",error?.stack||error?.message||error);return 0;}
  finally{client.release();}
}
async function bonusSummaryForUser(userId){
  const enabled=await cashbackEnabled();
  const bal=await db(`SELECT COALESCE(SUM(remaining),0) AS total FROM bonus_lots WHERE user_id=$1 AND status='active' AND remaining>0 AND expires_at>NOW()`,[String(userId)]);
  const next=await db(`SELECT expires_at,SUM(remaining) AS amount FROM bonus_lots WHERE user_id=$1 AND status='active' AND remaining>0 AND expires_at>NOW() GROUP BY expires_at ORDER BY expires_at ASC LIMIT 1`,[String(userId)]);
  const earned=await db(`SELECT COALESCE(SUM(amount),0) AS total FROM bonus_lots WHERE user_id=$1`,[String(userId)]);
  return{enabled,balance:Number(bal.rows[0]?.total||0),nextExpiry:next.rows[0]?.expires_at?{amount:Number(next.rows[0].amount||0),date:next.rows[0].expires_at}:null,totalEarned:Number(earned.rows[0]?.total||0),expiryDays:BONUS_EXPIRY_DAYS,maxCashback:BONUS_MAX_CASHBACK};
}
async function adminBonusSummary(){
  const r=await db(`SELECT COALESCE(SUM(amount),0) AS issued,COALESCE(SUM(remaining) FILTER(WHERE status='active' AND expires_at>NOW()),0) AS outstanding,COALESCE(SUM(amount) FILTER(WHERE status='expired'),0) AS expired_lots FROM bonus_lots`);
  const sp=await db(`SELECT COALESCE(SUM(amount) FILTER(WHERE restored=FALSE),0) AS spent FROM bonus_spends`);
  const ex=await db(`SELECT COALESCE(SUM(-amount),0) AS expired FROM financial_ledger WHERE account_type='customer_bonus' AND category='bonus_expired'`);
  return{enabled:await cashbackEnabled(),issued:Number(r.rows[0].issued||0),spent:Number(sp.rows[0].spent||0),expired:Number(ex.rows[0].expired||0),outstanding:Number(r.rows[0].outstanding||0)};
}

/* ===================== BOLTIV REFERRALS =====================
   A friend who signs up with a code must spend REFERRAL_THRESHOLD (wallet-paid, successful purchases)
   within REFERRAL_WINDOW_DAYS. Then BOTH people receive bonus balance (same lots as cashback: 90-day
   expiry, spendable, never withdrawable). Isolated: a referral failure must never break a purchase
   or a sign-up. */
const REFERRAL_THRESHOLD=3000;
const REFERRAL_REFERRER_REWARD=100;
const REFERRAL_FRIEND_REWARD=50;
const REFERRAL_WINDOW_DAYS=30;
const REFERRAL_MONTHLY_CAP=20;
async function referralEnabled(){
  const v=await getPlatformSetting("referral_enabled",true);
  return v!==false&&v!=="false";
}
function makeReferralCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes=crypto.randomBytes(7);
  let out="";
  for(let i=0;i<7;i++)out+=chars[bytes[i]%chars.length];
  return out;
}
async function getOrCreateReferralCode(userId){
  const existing=await db(`SELECT code FROM referral_codes WHERE user_id=$1`,[String(userId)]);
  if(existing.rows.length)return existing.rows[0].code;
  for(let i=0;i<6;i++){
    const ins=await db(`INSERT INTO referral_codes(user_id,code) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING code`,[String(userId),makeReferralCode()]);
    if(ins.rows.length)return ins.rows[0].code;
    const again=await db(`SELECT code FROM referral_codes WHERE user_id=$1`,[String(userId)]);
    if(again.rows.length)return again.rows[0].code;
  }
  throw new Error("Could not create a referral code.");
}
async function linkReferralOnSignup(user,rawCode){
  try{
    const code=String(rawCode||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
    if(code.length<4||code.length>12)return;
    if(!(await referralEnabled()))return;
    const r=await db(`SELECT user_id FROM referral_codes WHERE code=$1`,[code]);
    if(!r.rows.length)return;
    const referrerId=String(r.rows[0].user_id);
    if(referrerId===String(user.user_id))return;
    const samePhone=await db(`SELECT 1 FROM users WHERE user_id=$1 AND phone=$2`,[referrerId,user.phone]);
    if(samePhone.rows.length)return; // same phone number = treated as self-referral
    await db(`INSERT INTO referrals(referrer_id,referred_id,code,status,window_ends_at) VALUES($1,$2,$3,'pending',NOW()+INTERVAL '${REFERRAL_WINDOW_DAYS} days') ON CONFLICT(referred_id) DO NOTHING`,[referrerId,String(user.user_id),code]);
  }catch(error){console.error("REFERRAL LINK ERROR:",error?.stack||error?.message||error);}
}
// Wallet-paid value of successful purchases since the referral started (bonus-paid part does not count).
async function referralSpentTx(client,userId,since){
  const r=await client.query(`SELECT COALESCE(SUM(amount-COALESCE((metadata->'bonus'->>'used')::numeric,0)),0) AS spent FROM transactions WHERE user_id=$1 AND type='debit' AND status='successful' AND date>=$2`,[String(userId),since]);
  return Number(r.rows[0]?.spent||0);
}
async function referralLotTx(client,{userId,sourceReference,transactionReference,amount,ledgerReference,description,referralId,transactionId}){
  const ins=await client.query(`INSERT INTO bonus_lots(user_id,source_reference,transaction_reference,amount,remaining,expires_at) VALUES($1,$2,$3,$4::numeric,$4::numeric,NOW()+INTERVAL '${BONUS_EXPIRY_DAYS} days') ON CONFLICT(source_reference) DO NOTHING RETURNING id`,[String(userId),sourceReference,String(transactionReference),amount]);
  if(!ins.rows.length)return 0;
  const after=await bonusAvailableFor(client,userId);
  await addFinancialLedger(client,{accountType:"customer_bonus",ownerId:userId,direction:"credit",amount,balanceAfter:after,reference:ledgerReference,transactionId,category:"referral_reward",description,metadata:{referral_id:referralId}});
  return amount;
}
// Returns {referrerId,referredId,referrerPaid,friendPaid} when rewards were just paid, else null. Never throws.
async function checkReferralQualificationTx(client,tx){
  try{
    if(!(await referralEnabled()))return null;
    await client.query("SAVEPOINT referral_check");
    try{
      const ref=await client.query(`SELECT * FROM referrals WHERE referred_id=$1 AND status='pending' AND window_ends_at>NOW() FOR UPDATE`,[String(tx.user_id)]);
      if(!ref.rows.length){await client.query("RELEASE SAVEPOINT referral_check");return null;}
      const row=ref.rows[0];
      const spent=await referralSpentTx(client,tx.user_id,row.created_at);
      if(spent<REFERRAL_THRESHOLD){await client.query("RELEASE SAVEPOINT referral_check");return null;}
      const cnt=await client.query(`SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_id=$1 AND status='rewarded' AND qualified_at>NOW()-INTERVAL '30 days'`,[row.referrer_id]);
      const referrerCapped=Number(cnt.rows[0]?.n||0)>=REFERRAL_MONTHLY_CAP;
      const friendPaid=await referralLotTx(client,{userId:row.referred_id,sourceReference:`REFERRAL-FRIEND-${row.id}`,transactionReference:tx.reference,amount:REFERRAL_FRIEND_REWARD,ledgerReference:`BONUS-REFERRAL-FRIEND-${row.id}`,description:"Referral welcome bonus",referralId:row.id,transactionId:tx.id});
      const referrerPaid=referrerCapped?0:await referralLotTx(client,{userId:row.referrer_id,sourceReference:`REFERRAL-REFERRER-${row.id}`,transactionReference:tx.reference,amount:REFERRAL_REFERRER_REWARD,ledgerReference:`BONUS-REFERRAL-REFERRER-${row.id}`,description:"Referral reward",referralId:row.id,transactionId:tx.id});
      await client.query(`UPDATE referrals SET status='rewarded',qualified_at=NOW(),referrer_reward=$2,friend_reward=$3 WHERE id=$1`,[row.id,referrerPaid,friendPaid]);
      await client.query("RELEASE SAVEPOINT referral_check");
      return{referrerId:row.referrer_id,referredId:row.referred_id,referrerPaid,friendPaid};
    }catch(error){
      await client.query("ROLLBACK TO SAVEPOINT referral_check");
      console.error("REFERRAL QUALIFY ERROR:",error?.stack||error?.message||error);
      return null;
    }
  }catch(error){console.error("REFERRAL QUALIFY ERROR:",error?.stack||error?.message||error);return null;}
}
// If a refund drops the friend below the threshold, take back whatever is left of both rewards.
async function reverseReferralIfUnqualifiedTx(client,userId){
  try{
    await client.query("SAVEPOINT referral_reverse");
    try{
      const ref=await client.query(`SELECT * FROM referrals WHERE referred_id=$1 AND status='rewarded' FOR UPDATE`,[String(userId)]);
      if(!ref.rows.length){await client.query("RELEASE SAVEPOINT referral_reverse");return 0;}
      const row=ref.rows[0];
      const spent=await referralSpentTx(client,userId,row.created_at);
      if(spent>=REFERRAL_THRESHOLD){await client.query("RELEASE SAVEPOINT referral_reverse");return 0;}
      let total=0;
      for(const tag of ["FRIEND","REFERRER"]){
        const lot=await client.query(`SELECT id,user_id,remaining FROM bonus_lots WHERE source_reference=$1 FOR UPDATE`,[`REFERRAL-${tag}-${row.id}`]);
        if(!lot.rows.length||toKobo(lot.rows[0].remaining)<=0)continue;
        const left=Number(lot.rows[0].remaining);
        await client.query(`UPDATE bonus_lots SET remaining=0,status='reversed',updated_at=NOW() WHERE id=$1`,[lot.rows[0].id]);
        const after=await bonusAvailableFor(client,lot.rows[0].user_id);
        await addFinancialLedger(client,{accountType:"customer_bonus",ownerId:lot.rows[0].user_id,direction:"debit",amount:-left,balanceAfter:after,reference:`BONUS-REFERRAL-REVERSE-${tag}-${row.id}`,category:"referral_reversed",description:"Referral reward reversed after refund",metadata:{referral_id:row.id}});
        total+=left;
      }
      await client.query(`UPDATE referrals SET status='reversed' WHERE id=$1`,[row.id]);
      await client.query("RELEASE SAVEPOINT referral_reverse");
      return total;
    }catch(error){
      await client.query("ROLLBACK TO SAVEPOINT referral_reverse");
      console.error("REFERRAL REVERSE ERROR:",error?.stack||error?.message||error);
      return 0;
    }
  }catch(error){console.error("REFERRAL REVERSE ERROR:",error?.stack||error?.message||error);return 0;}
}
async function referralSummaryForUser(userId){
  const enabled=await referralEnabled();
  const code=await getOrCreateReferralCode(userId);
  const mine=await db(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='pending')::int AS pending,COUNT(*) FILTER(WHERE status='rewarded')::int AS rewarded,COALESCE(SUM(referrer_reward) FILTER(WHERE status='rewarded'),0) AS earned FROM referrals WHERE referrer_id=$1`,[String(userId)]);
  const asFriendRow=(await db(`SELECT status,created_at,window_ends_at,friend_reward FROM referrals WHERE referred_id=$1 LIMIT 1`,[String(userId)])).rows[0];
  let asFriend=null;
  if(asFriendRow){
    const sp=await db(`SELECT COALESCE(SUM(amount-COALESCE((metadata->'bonus'->>'used')::numeric,0)),0) AS spent FROM transactions WHERE user_id=$1 AND type='debit' AND status='successful' AND date>=$2`,[String(userId),asFriendRow.created_at]);
    asFriend={status:asFriendRow.status,spent:Number(sp.rows[0]?.spent||0),endsAt:asFriendRow.window_ends_at,reward:Number(asFriendRow.friend_reward||0)||REFERRAL_FRIEND_REWARD,expired:asFriendRow.status==="pending"&&new Date(asFriendRow.window_ends_at).getTime()<Date.now()};
  }
  const m=mine.rows[0]||{};
  return{enabled,code,link:`${String(FRONTEND_URL).replace(/\/+$/,"")}/register?ref=${code}`,threshold:REFERRAL_THRESHOLD,referrerReward:REFERRAL_REFERRER_REWARD,friendReward:REFERRAL_FRIEND_REWARD,windowDays:REFERRAL_WINDOW_DAYS,monthlyCap:REFERRAL_MONTHLY_CAP,stats:{total:Number(m.total||0),pending:Number(m.pending||0),rewarded:Number(m.rewarded||0),earned:Number(m.earned||0)},asFriend};
}
async function adminReferralSummary(){
  const r=await db(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='rewarded')::int AS rewarded,COALESCE(SUM(referrer_reward+friend_reward) FILTER(WHERE status='rewarded'),0) AS paid FROM referrals`);
  return{enabled:await referralEnabled(),total:Number(r.rows[0]?.total||0),rewarded:Number(r.rows[0]?.rewarded||0),paid:Number(r.rows[0]?.paid||0)};
}

async function finalizeVTUTransaction(transactionId,outcome,providerData={},providerReference=null,opts={}){
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
const cashbackEarned=await awardCashbackTx(client,fresh);
const referralResult=await checkReferralQualificationTx(client,fresh);
await client.query("COMMIT");
// Notifications are created after the transaction commit so a notification
// failure can never roll back a successful customer purchase.
if(!opts.quiet)try{
  const meta=fresh.metadata&&typeof fresh.metadata==="object"?fresh.metadata:{};
  let detail=`Your ${String(fresh.service||"service")} purchase of ₦${Number(fresh.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
  if(String(fresh.service).toLowerCase()==="data"){
    const network=clean(meta.network||meta.network_provider||"");
    const plan=clean(meta.plan||meta.plan_name||"");
    if(network||plan)detail=`Your ${network||"Data"} ${plan||"data plan"} purchase of ₦${Number(fresh.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} was successful.`;
  }
  await addNotificationOnce(fresh.user_id,"Transaction successful",detail,"transaction",`tx-success-${fresh.id}`);
}catch(error){console.error("TRANSACTION NOTIFICATION ERROR:",error?.stack||error?.message||error);}
if(!opts.quiet)try{ await sendTransactionEmail(fresh.user_id,fresh,"successful"); }catch(error){ console.error("TRANSACTION EMAIL HOOK ERROR:",error?.stack||error?.message||error); }
if(cashbackEarned>0){try{await addNotificationOnce(fresh.user_id,"Cashback earned",`You earned ₦${Number(cashbackEarned).toLocaleString("en-NG",{minimumFractionDigits:2})} cashback on your data purchase. It is in your Bonus Balance and expires in ${BONUS_EXPIRY_DAYS} days.`,"transaction",`cashback-${fresh.id}`);}catch(error){console.error("CASHBACK NOTIFICATION ERROR:",error?.stack||error?.message||error);}}
if(referralResult){try{
if(referralResult.friendPaid>0)await addNotificationOnce(referralResult.referredId,"Referral bonus unlocked",`You unlocked a \u20A6${referralResult.friendPaid} welcome bonus. It is in your Bonus Balance and expires in ${BONUS_EXPIRY_DAYS} days.`,"info",`referral-friend-${fresh.id}`);
if(referralResult.referrerPaid>0)await addNotificationOnce(referralResult.referrerId,"Referral reward earned",`Your friend completed \u20A6${REFERRAL_THRESHOLD.toLocaleString("en-NG")} in purchases. \u20A6${referralResult.referrerPaid} was added to your Bonus Balance.`,"info",`referral-referrer-${fresh.id}`);
}catch(error){console.error("REFERRAL NOTIFICATION ERROR:",error?.stack||error?.message||error);}}
return {success:true,status:"successful"};
}
if(outcome==="failed"||outcome==="refunded"){
if(!tx.refunded_at){
const bonusRestored=await restoreBonusForTx(client,tx);
const walletRefund=Number((Number(tx.amount)-bonusRestored).toFixed(2));
const wr=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[walletRefund,tx.user_id]);
if(!wr.rows.length)throw new Error("Wallet could not be credited for refund.");
await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:tx.user_id,direction:"credit",amount:walletRefund,balanceAfter:Number(wr.rows[0].balance),reference:`WALLET-REFUND-${tx.reference}`,transactionId:tx.id,category:"vtu_refund",description:`Refund for ${tx.service}`,metadata:{reason:outcome}});
}
await client.query(`UPDATE transactions SET status='refunded',provider_reference=COALESCE(provider_reference,$2),refunded_at=COALESCE(refunded_at,NOW()),completed_at=COALESCE(completed_at,NOW()),last_provider_status=$4,refund_reason=$5,metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb WHERE id=$1`,[transactionId,ref,JSON.stringify({provider_response:providerData,refund_reason:outcome}),outcome,outcome]);
const fresh=(await client.query(`SELECT * FROM transactions WHERE id=$1`,[transactionId])).rows[0];
if(!tx.refunded_at)await recordRevenueRefund(client,fresh);
await client.query("COMMIT");if(!tx.refunded_at&&!opts.quiet){try{await addNotificationOnce(tx.user_id,"Transaction refunded",`Your ${String(tx.service||"service")} transaction of ₦${Number(tx.amount).toLocaleString("en-NG",{minimumFractionDigits:2})} could not be completed. The amount has been returned to your wallet.` ,"transaction",`tx-refund-${tx.id}`);}catch{}}
if(!tx.refunded_at&&!opts.quiet){try{await sendTransactionEmail(tx.user_id,fresh,"refunded");}catch(error){console.error("REFUND EMAIL HOOK ERROR:",error?.stack||error?.message||error);}}
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
try{await client.query("BEGIN");const q=await client.query(`SELECT * FROM transactions WHERE reference=$1 FOR UPDATE`,[ref]);if(!q.rows.length){await client.query("ROLLBACK");return {success:false,statusCode:404,message:"Transaction not found."};}const tx=q.rows[0];if(tx.type!=="debit"){await client.query("ROLLBACK");return {success:false,statusCode:400,message:"Only debit transactions can be refunded."};}if(tx.status==="successful"||tx.status==="pending"||tx.status==="processing"){if(!tx.refunded_at){const bonusRestored=await restoreBonusForTx(client,tx);const walletRefund=Number((Number(tx.amount)-bonusRestored).toFixed(2));if(tx.status==="successful")await reverseCashbackTx(client,tx);const wr=await client.query(`UPDATE wallets SET balance=balance+$1,updated_at=NOW() WHERE user_id=$2 RETURNING balance`,[walletRefund,tx.user_id]);if(!wr.rows.length)throw new Error("Wallet could not be credited.");await addFinancialLedger(client,{accountType:"customer_wallet",ownerId:tx.user_id,direction:"credit",amount:walletRefund,balanceAfter:Number(wr.rows[0].balance),reference:`WALLET-ADMIN-REFUND-${tx.reference}`,transactionId:tx.id,category:"admin_refund",description:`Admin refund for ${tx.service}`,metadata:{reason,admin_id:check.admin.id}});await recordRevenueRefund(client,tx);}await client.query(`UPDATE transactions SET status='refunded',refunded_at=COALESCE(refunded_at,NOW()),completed_at=COALESCE(completed_at,NOW()),metadata=COALESCE(metadata,'{}'::jsonb)||$2::jsonb WHERE id=$1`,[tx.id,JSON.stringify({admin_refund:true,reason,admin_id:check.admin.id})]);await reverseReferralIfUnqualifiedTx(client,tx.user_id);}else if(tx.status==="refunded"){await client.query("COMMIT");return {success:true,alreadyRefunded:true,message:"Transaction was already refunded."};}else{await client.query("ROLLBACK");return {success:false,statusCode:400,message:"This transaction cannot be refunded in its current state."};}await client.query("COMMIT");return {success:true,message:"Transaction refunded successfully."};}catch(e){try{await client.query("ROLLBACK")}catch{};return {success:false,statusCode:500,message:"Refund failed."};}finally{client.release();}
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
CREATE TABLE IF NOT EXISTS agent_profiles(
user_id TEXT PRIMARY KEY,
agent_id TEXT UNIQUE NOT NULL,
status TEXT NOT NULL DEFAULT 'active',
tier TEXT NOT NULL DEFAULT 'standard',
max_transaction_override NUMERIC(14,2),
daily_limit_override NUMERIC(14,2),
daily_count_override INTEGER,
activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS max_transaction_override NUMERIC(14,2)`);
await db(`ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS daily_limit_override NUMERIC(14,2)`);
await db(`ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS daily_count_override INTEGER`);
await db(`CREATE INDEX IF NOT EXISTS agent_profiles_status_idx ON agent_profiles(status)`);
await db(`
CREATE TABLE IF NOT EXISTS agent_services(
user_id TEXT NOT NULL,
service_key TEXT NOT NULL,
enabled BOOLEAN NOT NULL DEFAULT TRUE,
markup_pct_override NUMERIC(6,2),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
PRIMARY KEY(user_id,service_key)
)`);
await db(`ALTER TABLE agent_services ADD COLUMN IF NOT EXISTS markup_pct_override NUMERIC(6,2)`);
await db(`CREATE INDEX IF NOT EXISTS agent_services_service_idx ON agent_services(service_key)`);
await db(`
CREATE TABLE IF NOT EXISTS agent_customers(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
name TEXT NOT NULL,
phone TEXT NOT NULL,
network TEXT,
notes TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
await db(`CREATE INDEX IF NOT EXISTS agent_customers_user_idx ON agent_customers(user_id)`);

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
await db(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS batch_id TEXT`);
await db(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'`);
await db(`CREATE INDEX IF NOT EXISTS notifications_batch_idx ON notifications(batch_id) WHERE batch_id IS NOT NULL`);
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
await db(`INSERT INTO services(key,name,icon,config) VALUES('international','International Top-up','🌍',$1::jsonb) ON CONFLICT(key) DO NOTHING`,[JSON.stringify({pricing:{mode:'discount',discount_pct:5,fixed_profit:0}})]);
await db(`INSERT INTO services(key,name,icon,config) VALUES('sms','Bulk SMS','💬',$1::jsonb) ON CONFLICT(key) DO NOTHING`,[JSON.stringify({pricing:{mode:'discount',discount_pct:20,fixed_profit:0}})]);
await db(`CREATE TABLE IF NOT EXISTS sms_sender_ids(id BIGSERIAL PRIMARY KEY,user_id TEXT,sender_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',provider_id BIGINT,details JSONB NOT NULL DEFAULT '{}'::jsonb,notes TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE UNIQUE INDEX IF NOT EXISTS sms_sender_ids_active_uq ON sms_sender_ids(sender_id) WHERE status<>'rejected'`);
await db(`DELETE FROM services WHERE key NOT IN ('airtime','data','electricity','cable','exam_pin','international','sms')`);
// "Fixed profit per sale" pricing has been removed in favor of percentage-only pricing —
// migrate any service still configured that way over to discount/percentage mode.
await db(`UPDATE services SET config=jsonb_set(jsonb_set(config,'{pricing,mode}','"discount"'::jsonb,true),'{pricing,fixed_profit}','0'::jsonb,true),updated_at=NOW() WHERE config->'pricing'->>'mode' IN ('fixed','fixed_profit')`);
await db(`DELETE FROM services WHERE key IN ('education','betting','sms')`);
for(const [key,value] of [['maintenance_mode',false],['registration_enabled',true],['announcement_enabled',true],['announcement_text','Welcome to BOLTIV — Fast. Simple. Powerful.'],['announcement_items',[{text:'Welcome to BOLTIV — Fast. Simple. Powerful.',enabled:true}]]]) await db(`INSERT INTO platform_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO NOTHING`,[key,JSON.stringify(value)]);

// GLOBAL Agent pricing — one configuration row per service, applied identically to every
// BOLTIV Agent. Deliberately a dedicated table (not folded into services.config) so it reads
// as a proper pricing configuration in its own right, and so "active" can independently gate
// Agent access to a service without touching that service's own B2C enabled/maintenance state.
await db(`CREATE TABLE IF NOT EXISTS agent_pricing(
id BIGSERIAL PRIMARY KEY,
service TEXT UNIQUE NOT NULL,
markup_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
fixed_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
active BOOLEAN NOT NULL DEFAULT TRUE,
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
for(const key of ['airtime','data','electricity','cable']) await db(`INSERT INTO agent_pricing(service,markup_percent,fixed_fee,active) VALUES($1,0,0,true) ON CONFLICT(service) DO NOTHING`,[key]);
// One-time migration: an earlier iteration stored the Agent markup percentage inside each
// service's own config JSONB. Carry any value already set there into the new table so nothing
// admins previously configured gets silently reset to zero.
await db(`UPDATE agent_pricing ap SET markup_percent=LEAST(500,GREATEST(0,COALESCE((s.config->'agent_pricing'->>'markup_pct')::numeric,0))),updated_at=NOW() FROM services s WHERE s.key=ap.service AND s.config->'agent_pricing'->>'markup_pct' IS NOT NULL AND ap.markup_percent=0`);

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
// BONUS / CASHBACK (additive tables - nothing existing is altered)
try{
await db(`CREATE TABLE IF NOT EXISTS bonus_lots(id BIGSERIAL PRIMARY KEY,user_id TEXT NOT NULL,source_reference TEXT UNIQUE NOT NULL,transaction_reference TEXT,amount NUMERIC(14,2) NOT NULL,remaining NUMERIC(14,2) NOT NULL,status TEXT NOT NULL DEFAULT 'active',expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS bonus_lots_user_idx ON bonus_lots(user_id,status,expires_at)`);
await db(`CREATE TABLE IF NOT EXISTS bonus_spends(id BIGSERIAL PRIMARY KEY,lot_id BIGINT NOT NULL,user_id TEXT NOT NULL,transaction_reference TEXT NOT NULL,amount NUMERIC(14,2) NOT NULL,restored BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS bonus_spends_tx_idx ON bonus_spends(transaction_reference)`);
}catch(error){console.error("BONUS SCHEMA ERROR:",error?.stack||error?.message||error);}
// REFERRALS (additive tables)
try{
await db(`CREATE TABLE IF NOT EXISTS referral_codes(user_id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE TABLE IF NOT EXISTS referrals(id BIGSERIAL PRIMARY KEY,referrer_id TEXT NOT NULL,referred_id TEXT UNIQUE NOT NULL,code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',referrer_reward NUMERIC(14,2) NOT NULL DEFAULT 0,friend_reward NUMERIC(14,2) NOT NULL DEFAULT 0,window_ends_at TIMESTAMPTZ NOT NULL,qualified_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id,status)`);
}catch(error){console.error("REFERRAL SCHEMA ERROR:",error?.stack||error?.message||error);}
await db(`CREATE INDEX IF NOT EXISTS financial_ledger_account_idx ON financial_ledger(account_type,owner_id,created_at DESC)`);
await db(`CREATE INDEX IF NOT EXISTS financial_ledger_transaction_idx ON financial_ledger(transaction_id)`);
await db(`CREATE INDEX IF NOT EXISTS financial_ledger_category_idx ON financial_ledger(category,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS autopay_schedules(
id BIGSERIAL PRIMARY KEY,
user_id TEXT NOT NULL,
service TEXT NOT NULL,
label TEXT NOT NULL,
frequency TEXT NOT NULL,
day_of_week INT,
day_of_month INT,
amount NUMERIC(14,2) NOT NULL,
payload JSONB NOT NULL,
status TEXT NOT NULL DEFAULT 'active',
pause_reason TEXT,
next_run_at TIMESTAMPTZ,
cycle_for TIMESTAMPTZ,
attempt INT NOT NULL DEFAULT 1,
last_run_at TIMESTAMPTZ,
last_status TEXT,
consecutive_failures INT NOT NULL DEFAULT 0,
reminded_for TIMESTAMPTZ,
locked_until TIMESTAMPTZ,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);
// Additive AutoPay price-protection migration. Existing schedules use their current saved amount as the initial limit.
await db(`ALTER TABLE autopay_schedules ADD COLUMN IF NOT EXISTS max_amount NUMERIC(14,2)`);
await db(`UPDATE autopay_schedules SET max_amount=amount WHERE max_amount IS NULL`);
await db(`ALTER TABLE autopay_schedules ADD COLUMN IF NOT EXISTS price_block JSONB`);
await db(`CREATE INDEX IF NOT EXISTS autopay_schedules_due_idx ON autopay_schedules(status,next_run_at)`);
await db(`CREATE INDEX IF NOT EXISTS autopay_schedules_user_idx ON autopay_schedules(user_id)`);
await db(`CREATE TABLE IF NOT EXISTS autopay_runs(
id BIGSERIAL PRIMARY KEY,
schedule_id BIGINT NOT NULL,
user_id TEXT NOT NULL,
run_key TEXT UNIQUE NOT NULL,
scheduled_for TIMESTAMPTZ NOT NULL,
attempt INT NOT NULL DEFAULT 1,
status TEXT NOT NULL DEFAULT 'running',
amount NUMERIC(14,2),
message TEXT,
transaction_reference TEXT,
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
finished_at TIMESTAMPTZ
)`);
await db(`CREATE INDEX IF NOT EXISTS autopay_runs_user_idx ON autopay_runs(user_id,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS autopay_audit(id BIGSERIAL PRIMARY KEY,user_id TEXT NOT NULL,schedule_id BIGINT,action TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
await db(`CREATE INDEX IF NOT EXISTS autopay_audit_user_idx ON autopay_audit(user_id,created_at DESC)`);
await db(`CREATE INDEX IF NOT EXISTS autopay_audit_schedule_idx ON autopay_audit(schedule_id,created_at DESC)`);
await db(`CREATE TABLE IF NOT EXISTS user_favorites(id BIGSERIAL PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,recipient TEXT NOT NULL,network TEXT,provider TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(user_id,kind,recipient))`);
await db(`CREATE INDEX IF NOT EXISTS user_favorites_user_idx ON user_favorites(user_id,updated_at DESC)`);
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
  const b=await body(req),recipient=clean(b.recipient||"all").toLowerCase(),title=clean(b.title),message=clean(b.message),type=clean(b.type||"general"),priority=clean(b.priority||"normal"),alsoEmail=Boolean(b.sendEmail);
  if(title.length<2||message.length<2)return{success:false,statusCode:400,message:"Notification title and message are required."};
  let recipients=[];
  if(recipient==="selected"){
    const id=clean(b.userId||b.user_id); if(!id)return{success:false,statusCode:400,message:"Select a user."};
    const u=await db(`SELECT user_id,email,name FROM users WHERE user_id=$1 OR LOWER(email)=LOWER($1) LIMIT 1`,[id]); if(!u.rows.length)return{success:false,statusCode:404,message:"User not found."}; recipients=u.rows;
  }else if(recipient==="active"){recipients=(await db(`SELECT user_id,email,name FROM users WHERE status='active' ORDER BY created_at ASC`)).rows;}
  else{recipients=(await db(`SELECT user_id,email,name FROM users ORDER BY created_at ASC`)).rows;}
  if(!recipients.length)return{success:false,statusCode:400,message:"No eligible users found."};
  const userIds=recipients.map(x=>x.user_id);
  const batchId=crypto.randomUUID();
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    for(const uid of userIds)await client.query(`INSERT INTO notifications(user_id,title,message,type,batch_id,priority) VALUES($1,$2,$3,$4,$5,$6)`,[uid,title,message,type,batchId,priority]);
    await client.query("COMMIT");
  }catch(e){try{await client.query("ROLLBACK")}catch{} throw e;}
  finally{client.release();}
  try{await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,'notification_send','user','broadcast',$2::jsonb,$3)`,[admin.id,JSON.stringify({recipient,count:userIds.length,title,type,alsoEmail}),requestIp(req)]);}catch{}
  let emailResult=null;
  if(alsoEmail){
    const withEmail=recipients.filter(x=>clean(x.email));
    emailResult=await sendBulkNotificationEmails(withEmail,title,message,priority);
    try{await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,'notification_email_send','user','broadcast',$2::jsonb,$3)`,[admin.id,JSON.stringify({batchId,attempted:withEmail.length,sent:emailResult.sent,failed:emailResult.failed}),requestIp(req)]);}catch{}
  }
  return{success:true,sent:userIds.length,emailed:emailResult?emailResult.sent:0,emailFailed:emailResult?emailResult.failed:0,message:`Notification sent to ${userIds.length} user(s).`+(alsoEmail?` Email delivered to ${emailResult.sent} of ${emailResult.sent+emailResult.failed}.`:"")};
}
async function sendBulkNotificationEmails(recipients,title,message,priority){
  let sent=0,failed=0;
  const concurrency=5;
  const queue=[...recipients];
  async function worker(){
    while(queue.length){
      const u=queue.shift();
      try{
        const r=await sendEmail({
          to:u.email,
          subject:`${priority==="urgent"?"[URGENT] ":priority==="high"?"[Important] ":""}${title}`,
          html:`<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto"><h2 style="margin-bottom:4px">${title}</h2><p style="color:#333;line-height:1.6">${String(message).replace(/\n/g,"<br>")}</p><p style="margin-top:24px;font-size:12px;color:#999">BOLTIV${u.name?` &middot; Hi ${u.name}`:""}</p></div>`
        });
        if(r&&r.success)sent++;else failed++;
      }catch{failed++;}
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,recipients.length)},worker));
  return{sent,failed};
}
async function adminNotificationsOverview(req){
  const admin=await adminFromToken(req); if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  const totalR=await db(`SELECT COUNT(*)::int AS c FROM notifications`);
  const todayR=await db(`SELECT COUNT(*)::int AS c FROM notifications WHERE created_at>=date_trunc('day',NOW())`);
  const readR=await db(`SELECT COUNT(*)::int AS c FROM notifications WHERE read=TRUE`);
  const unreadR=await db(`SELECT COUNT(*)::int AS c FROM notifications WHERE read=FALSE`);
  const histR=await db(`
    SELECT COALESCE(batch_id,'legacy-'||id::text) AS batch_id, title, message, type, MAX(priority) AS priority,
      MIN(created_at) AS created_at, COUNT(*)::int AS recipients,
      SUM(CASE WHEN read THEN 1 ELSE 0 END)::int AS read_count
    FROM notifications
    GROUP BY COALESCE(batch_id,'legacy-'||id::text), title, message, type
    ORDER BY MIN(created_at) DESC
    LIMIT 100
  `);
  return{success:true,stats:{total:totalR.rows[0].c,today:todayR.rows[0].c,read:readR.rows[0].c,unread:unreadR.rows[0].c},history:histR.rows};
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
  const elec=String(item.service||"").toLowerCase().includes("electric")?electricityDetailsFromMetadata(meta):{};
  return {...item,amount:Number(item.amount),phone,network,plan,...elec};
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
termsAccepted,
referralCode
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

await linkReferralOnSignup(user,referralCode);

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

const agent=await getAgentProfile(user.user_id);
const isAgent=agent&&agent.status==='active';

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
email:user.email,
accountType:isAgent?'agent':'customer',
isAgent:!!isAgent,
agent
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
    let meta=tx.metadata;if(typeof meta==="string"){try{meta=JSON.parse(meta);}catch{meta=null;}}
    const isAutopay=Boolean(meta&&meta.autopay);   // purchases made by AutoPay get their own wording
    const isScheduled=Boolean(isAutopay&&meta.autopay.once);
    const title=isScheduled
      ?(status==="successful"?"Scheduled payment successful":"Scheduled payment refunded")
      :isAutopay
      ?(status==="successful"?"AutoPay purchase successful":"AutoPay purchase refunded")
      :(status==="successful"?"Transaction successful":"Transaction refunded");
    const planName=isAutopay&&meta.pricing&&meta.pricing.plan?` (${escapeHtmlEmail(String(meta.pricing.plan))})`:"";
    const body=isScheduled
      ?(status==="successful"
        ?`Your scheduled purchase of ${service}${planName} for ₦${amount} was successful. It was paid from your BOLTIV wallet at the time you chose.`
        :`Your scheduled ${service} purchase of ₦${amount} was refunded to your BOLTIV wallet.`)
      :isAutopay
      ?(status==="successful"
        ?`Your AutoPay purchase of ${service}${planName} for ₦${amount} was successful. It ran automatically from your BOLTIV wallet.`
        :`Your AutoPay ${service} purchase of ₦${amount} was refunded to your BOLTIV wallet.`)
      :(status==="successful"
        ?`Your ${service} purchase of ₦${amount} was successful.`
        :`Your ${service} transaction of ₦${amount} was refunded to your BOLTIV wallet.`);
    const autopayLink=isAutopay?`<p style="text-align:center;margin:22px 0 6px"><a href="https://boltiv.ng${isScheduled?"/scheduled-payments":"/autopay"}" style="display:inline-block;background:#D4AF37;color:#171717;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:12px">${isScheduled?"Manage Scheduled Payments":"Manage AutoPay"}</a></p>`:"";
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
${autopayLink}
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
if(accountType==="static"&&ownerType==="user"){try{await addNotification(ownerId,'Funding account verified',`Your dedicated BOLTIV funding account ${account.accountNumber} (${account.bankName||''}) is ready. Your identity has been verified.`,'account');}catch{}}
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
let bonus=null;try{bonus=await adminBonusSummary();if(bonus)bonus.referral=await adminReferralSummary();}catch(error){console.error("ADMIN BONUS SUMMARY ERROR:",error?.message||error);}
return{success:true,summary:{balance:Number(w?.balance||0),sales:Number(r?.sales||0),refunds:Number(r?.refunds||0),grossProfit:Number(gross?.gross_profit||0),bonus},withdrawalsDisabled:true,withdrawalInstructions:"Withdrawals are handled directly in the Flutterwave dashboard."};
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
async function adminAnalytics(req){const admin=await adminFromToken(req);if(!admin)return{success:false,statusCode:401,message:'Unauthorized.'};try{const daily=(await db(`WITH d AS (SELECT generate_series(CURRENT_DATE-13,CURRENT_DATE,interval '1 day')::date AS day) SELECT d.day,COALESCE((SELECT COUNT(*) FROM users u WHERE u.created_at::date=d.day),0)::int AS users,COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.date::date=d.day),0)::int AS transactions,COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.date::date=d.day AND t.status='successful'),0)::int AS successful,COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.date::date=d.day AND t.type='debit' AND t.status='successful'),0) AS sales,COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.date::date=d.day AND t.type='credit' AND t.service='Wallet Funding' AND t.status='successful'),0) AS funding,COALESCE((SELECT SUM(ABS(t.amount)) FROM transactions t WHERE t.date::date=d.day AND t.status='refunded'),0) AS refunds,COALESCE((SELECT SUM(COALESCE((t.metadata->'pricing'->>'grossProfit')::numeric,0)) FROM transactions t WHERE t.date::date=d.day AND t.type='debit' AND t.status='successful'),0) AS profit FROM d ORDER BY d.day`)).rows;const services=(await db(`SELECT service,COUNT(*)::int AS transactions,COUNT(*) FILTER(WHERE status='successful')::int AS successful,COALESCE(SUM(amount) FILTER(WHERE status='successful' AND type='debit'),0) AS sales,COALESCE(SUM(COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0)) FILTER(WHERE status='successful' AND type='debit'),0) AS profit FROM transactions WHERE date>=NOW()-INTERVAL '30 days' GROUP BY service ORDER BY sales DESC`)).rows;const topUsers=(await db(`SELECT u.user_id,u.name,u.email,COUNT(t.id)::int AS transactions,COALESCE(SUM(t.amount) FILTER(WHERE t.type='debit' AND t.status='successful'),0) AS spend FROM users u JOIN transactions t ON t.user_id=u.user_id WHERE t.date>=NOW()-INTERVAL '30 days' GROUP BY u.user_id,u.name,u.email ORDER BY spend DESC LIMIT 10`)).rows;return{success:true,daily:daily.map(x=>({...x,sales:Number(x.sales||0),funding:Number(x.funding||0),refunds:Number(x.refunds||0),profit:Number(x.profit||0)})),services:services.map(x=>({...x,sales:Number(x.sales||0),profit:Number(x.profit||0)})),topUsers:topUsers.map(x=>({...x,spend:Number(x.spend||0)}))};}catch(e){console.error('ADMIN ANALYTICS ERROR:',e);return{success:false,statusCode:500,message:e.message||'Unable to load analytics right now.'};}}

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
    COALESCE((t.metadata->'pricing'->>'grossProfit')::numeric,0) AS gross_profit,
    t.metadata->'pricing'->>'agentPrice' AS agent_price,
    t.metadata->'pricing'->>'customerSellingPrice' AS customer_selling_price,
    t.metadata->'pricing'->>'agentProfit' AS agent_profit
    FROM transactions t LEFT JOIN users u ON u.user_id=t.user_id
    ORDER BY t.date DESC LIMIT 1000`);
  return{success:true,transactions:r.rows.map(x=>({...x,amount:Number(x.amount||0),providerCost:Number(x.provider_cost||0),grossProfit:Number(x.gross_profit||0),isAgentSale:x.agent_price!=null,agentPrice:x.agent_price!=null?Number(x.agent_price):null,customerSellingPrice:x.customer_selling_price!=null?Number(x.customer_selling_price):null,agentProfit:x.agent_profit!=null?Number(x.agent_profit):null}))};
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

// GLOBAL Agent Pricing admin API. One configuration per service, applied identically to every
// BOLTIV Agent — this intentionally does NOT touch agent_services.markup_pct_override (the
// existing per-agent negotiated-rate mechanism), which remains a separate, optional layer.
async function adminAgentPricing(req,action,serviceParam){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==='list'){
    const rows=await getAllAgentPricing();
    return{success:true,pricing:rows};
  }
  const serviceKey=clean(serviceParam);
  if(!serviceKey)return{success:false,statusCode:400,message:'Service is required.'};
  if(action==='get'){
    const exists=await db(`SELECT 1 FROM services WHERE key=$1`,[serviceKey]);
    if(!exists.rows.length)return{success:false,statusCode:404,message:'Unknown service.'};
    const row=await getAgentPricingRow(serviceKey);
    return{success:true,pricing:{service:row.service,markupPercent:Number(row.markup_percent||0),fixedFee:Number(row.fixed_fee||0),active:Boolean(row.active),updatedAt:row.updated_at}};
  }
  if(action==='update'){
    const exists=await db(`SELECT 1 FROM services WHERE key=$1`,[serviceKey]);
    if(!exists.rows.length)return{success:false,statusCode:404,message:'Unknown service.'};
    const b=await body(req);
    const markupPercent=Math.min(500,Math.max(0,Number(b.markupPercent??b.markup_percent??0)));
    const fixedFee=Math.max(0,Number(b.fixedFee??b.fixed_fee??0));
    const active=b.active!==false;
    if(!Number.isFinite(markupPercent)||!Number.isFinite(fixedFee))return{success:false,statusCode:400,message:'Markup and fee must be valid numbers.'};
    await db(`INSERT INTO agent_pricing(service,markup_percent,fixed_fee,active,updated_at) VALUES($1,$2,$3,$4,NOW())
      ON CONFLICT(service) DO UPDATE SET markup_percent=EXCLUDED.markup_percent,fixed_fee=EXCLUDED.fixed_fee,active=EXCLUDED.active,updated_at=NOW()`,[serviceKey,markupPercent,fixedFee,active]);
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,'agent_pricing_update','service',$2,$3::jsonb,$4)`,[admin.id,serviceKey,JSON.stringify({markupPercent,fixedFee,active}),requestIp(req)]);
    return adminAgentPricing(req,'get',serviceKey);
  }
  return{success:false,statusCode:400,message:'Unknown action.'};
}
async function adminAgents(req,action,userIdParam){
  const admin=await adminFromToken(req);
  if(!admin)return{success:false,statusCode:401,message:"Unauthorized."};
  if(action==='analytics'){
    const counts=await db(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='active')::int AS active,COUNT(*) FILTER(WHERE status='suspended')::int AS suspended,COUNT(*) FILTER(WHERE activated_at>=NOW()-INTERVAL '30 days')::int AS new_this_month FROM agent_profiles`);
    const volume=await db(`SELECT COUNT(*)::int AS transactions,COALESCE(SUM(amount) FILTER(WHERE status='successful'),0) AS volume,COALESCE(SUM(COALESCE((metadata->'pricing'->>'grossProfit')::numeric,0)) FILTER(WHERE status='successful'),0) AS revenue FROM transactions WHERE metadata->'pricing'->>'agentPrice' IS NOT NULL`);
    const top=await db(`SELECT t.user_id,a.agent_id,u.name,COUNT(*)::int AS transactions,COALESCE(SUM(t.amount) FILTER(WHERE t.status='successful'),0) AS volume FROM transactions t JOIN agent_profiles a ON a.user_id=t.user_id LEFT JOIN users u ON u.user_id=t.user_id WHERE t.metadata->'pricing'->>'agentPrice' IS NOT NULL GROUP BY t.user_id,a.agent_id,u.name ORDER BY volume DESC LIMIT 10`);
    const c=counts.rows[0]||{},v=volume.rows[0]||{};
    const totalVolume=Number(v.volume||0),totalActive=Number(c.active||0);
    return{success:true,totalAgents:Number(c.total||0),activeAgents:totalActive,suspendedAgents:Number(c.suspended||0),newThisMonth:Number(c.new_this_month||0),totalVolume,totalTransactions:Number(v.transactions||0),totalRevenue:Number(v.revenue||0),averageVolumePerAgent:totalActive>0?Number((totalVolume/totalActive).toFixed(2)):0,topAgents:top.rows.map(x=>({userId:x.user_id,agentId:x.agent_id,name:x.name,transactions:Number(x.transactions||0),volume:Number(x.volume||0)}))};
  }
  if(action==='list') {
    const r=await db(`SELECT a.user_id,a.agent_id,a.status,a.tier,a.activated_at,a.updated_at,u.name,u.email,u.phone,COALESCE(w.balance,0) AS balance,
      EXISTS(SELECT 1 FROM flutterwave_virtual_accounts fva WHERE fva.owner_type='user' AND fva.owner_id=a.user_id AND fva.account_type='static' AND fva.status='active') AS kyc_verified
      FROM agent_profiles a LEFT JOIN users u ON u.user_id=a.user_id LEFT JOIN wallets w ON w.user_id=a.user_id ORDER BY a.activated_at DESC LIMIT 1000`);
    return{success:true,agents:r.rows.map(x=>({...x,balance:Number(x.balance||0),kyc_verified:Boolean(x.kyc_verified)}))};
  }
  const userId=clean(userIdParam);
  if(!userId)return{success:false,statusCode:400,message:'Agent user ID is required.'};
  if(action==='details'){
    const a=await db(`SELECT a.user_id,a.agent_id,a.status,a.tier,a.max_transaction_override,a.daily_limit_override,a.daily_count_override,a.activated_at,a.updated_at,u.name,u.email,u.phone,COALESCE(w.balance,0) AS balance FROM agent_profiles a LEFT JOIN users u ON u.user_id=a.user_id LEFT JOIN wallets w ON w.user_id=a.user_id WHERE a.user_id=$1 LIMIT 1`,[userId]);
    if(!a.rows.length)return{success:false,statusCode:404,message:'Agent not found.'};
    const effectiveLimits=await getAgentLimits(a.rows[0]);
    const fva=await db(`SELECT account_number,bank_name,account_name FROM flutterwave_virtual_accounts WHERE owner_type='user' AND owner_id=$1 AND account_type='static' AND status='active' LIMIT 1`,[userId]);
    const services=await db(`SELECT s.key,s.name,s.icon,s.enabled AS platform_enabled,s.maintenance,COALESCE(a.enabled,TRUE) AS agent_enabled,a.markup_pct_override FROM services s LEFT JOIN agent_services a ON a.user_id=$1 AND a.service_key=s.key ORDER BY s.name`,[userId]);
    const pricingRows=await getAllAgentPricing();
    const pricingByService=new Map(pricingRows.map(p=>[p.service,p]));
    return{success:true,agent:{...a.rows[0],balance:Number(a.rows[0].balance||0)},staticAccount:fva.rows[0]||null,limits:effectiveLimits,limitOverrides:{maxTransaction:a.rows[0].max_transaction_override!=null?Number(a.rows[0].max_transaction_override):null,dailyLimit:a.rows[0].daily_limit_override!=null?Number(a.rows[0].daily_limit_override):null,dailyCount:a.rows[0].daily_count_override!=null?Number(a.rows[0].daily_count_override):null},services:services.rows.map(x=>{const globalRow=pricingByService.get(x.key);const pricing=agentPricingConfig(globalRow?{markup_percent:globalRow.markupPercent,fixed_fee:globalRow.fixedFee}:null,x.markup_pct_override!=null?Number(x.markup_pct_override):undefined);return {key:x.key,name:x.name,icon:x.icon,platform_enabled:Boolean(x.platform_enabled),maintenance:Boolean(x.maintenance),agent_enabled:Boolean(x.agent_enabled)&&Boolean(globalRow?globalRow.active:true),markup_pct_override:x.markup_pct_override!=null?Number(x.markup_pct_override):null,effective_markup_pct:pricing.markup_pct,effective_fixed_fee:pricing.markup_fixed};})};
  }
  if(action==='limits'){
    const b=await body(req);
    const toVal=(v)=>(v===null||v===''||v===undefined)?null:Math.max(0,Number(v));
    const maxTransaction=toVal(b.maxTransaction),dailyLimit=toVal(b.dailyLimit),dailyCount=toVal(b.dailyCount);
    const exists=await db(`SELECT 1 FROM agent_profiles WHERE user_id=$1`,[userId]);
    if(!exists.rows.length)return{success:false,statusCode:404,message:'Agent not found.'};
    await db(`UPDATE agent_profiles SET max_transaction_override=$1,daily_limit_override=$2,daily_count_override=$3,updated_at=NOW() WHERE user_id=$4`,[maxTransaction,dailyLimit,dailyCount!=null?Math.floor(dailyCount):null,userId]);
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,'agent_limits_override','agent',$2,$3::jsonb,$4)`,[admin.id,userId,JSON.stringify({maxTransaction,dailyLimit,dailyCount}),requestIp(req)]);
    return adminAgents(req,'details',userId);
  }
  if(action==='services'){
    const b=await body(req);
    const services=Array.isArray(b.services)?b.services:[];
    const agent=await db(`SELECT agent_id FROM agent_profiles WHERE user_id=$1 LIMIT 1`,[userId]);
    if(!agent.rows.length)return{success:false,statusCode:404,message:'Agent not found.'};
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      for(const item of services){
        const key=clean(item.key);if(!key)continue;
        const exists=await client.query(`SELECT 1 FROM services WHERE key=$1`,[key]);if(!exists.rows.length)continue;
        const overrideRaw=item.markup_pct_override;
        const override=(overrideRaw===null||overrideRaw===''||overrideRaw===undefined)?null:Math.min(500,Math.max(0,Number(overrideRaw)));
        await client.query(`INSERT INTO agent_services(user_id,service_key,enabled,markup_pct_override,updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(user_id,service_key) DO UPDATE SET enabled=EXCLUDED.enabled,markup_pct_override=EXCLUDED.markup_pct_override,updated_at=NOW()`,[userId,key,item.enabled!==false,Number.isFinite(override)?override:null]);
      }
      await client.query('COMMIT');
      await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,'agent_service_update','agent',$2,$3::jsonb,$4)`,[admin.id,userId,JSON.stringify({services:services.map(x=>({key:clean(x.key),enabled:x.enabled!==false,markup_pct_override:x.markup_pct_override??null}))}),requestIp(req)]);
      try{await addNotification(userId,'Agent services updated','BOLTIV has updated the services or pricing available on your Agent account. Check your profile for the latest details.','account');}catch{}
      return adminAgents(req,'details',userId);
    }catch(e){try{await client.query('ROLLBACK')}catch{};throw e;}finally{client.release();}
  }
  if(action==='status'){
    const b=await body(req);const status=clean(b.status).toLowerCase();
    if(!['active','suspended'].includes(status))return{success:false,statusCode:400,message:'Invalid agent status.'};
    const r=await db(`UPDATE agent_profiles SET status=$1,updated_at=NOW() WHERE user_id=$2 RETURNING user_id,agent_id,status,tier,activated_at,updated_at`,[status,userId]);
    if(!r.rows.length)return{success:false,statusCode:404,message:'Agent not found.'};
    try{await addNotification(userId,'Agent account updated',`Your BOLTIV Agent account is now ${status}.`,'account');}catch{}
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,'agent_status_update','agent',$2,$3::jsonb,$4)`,[admin.id,userId,JSON.stringify({status}),requestIp(req)]);
    return{success:true,agent:r.rows[0]};
  }
  return{success:false,statusCode:400,message:'Unsupported agent action.'};
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
  for(const key of ["maintenance_mode","registration_enabled","cashback_enabled","referral_enabled","autopay_enabled"]){
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
  if(Object.prototype.hasOwnProperty.call(b,"agent_limits")){
    const raw=b.agent_limits||{};
    const value={
      minWalletBalance:Math.max(0,Number(raw.minWalletBalance??DEFAULT_AGENT_LIMITS.minWalletBalance)),
      maxTransaction:Math.max(0,Number(raw.maxTransaction??DEFAULT_AGENT_LIMITS.maxTransaction)),
      dailyLimit:Math.max(0,Number(raw.dailyLimit??DEFAULT_AGENT_LIMITS.dailyLimit)),
      dailyCount:Math.max(1,Math.floor(Number(raw.dailyCount??DEFAULT_AGENT_LIMITS.dailyCount)))
    };
    await db(`INSERT INTO platform_settings(key,value,updated_at) VALUES('agent_limits',$1::jsonb,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,[JSON.stringify(value)]);
    await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,'agent_limits_update','platform_settings','agent_limits',$2::jsonb,$3)`,[admin.id,JSON.stringify(value),requestIp(req)]);
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
if(req.method==="GET"&&path==="/api/admin/notifications"){const result=await adminNotificationsOverview(req);return send(res,result.success?200:(result.statusCode||400),result);}
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
if(req.method==="GET"&&path==="/api/admin/agents"){const result=await adminAgents(req,'list');return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/agent-pricing"){const result=await adminAgentPricing(req,'list');return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path.startsWith("/api/admin/agent-pricing/")){const service=decodeURIComponent(path.slice("/api/admin/agent-pricing/".length));const result=await adminAgentPricing(req,'get',service);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="PATCH"&&path.startsWith("/api/admin/agent-pricing/")){const service=decodeURIComponent(path.slice("/api/admin/agent-pricing/".length));const result=await adminAgentPricing(req,'update',service);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path==="/api/admin/agents/analytics"){const result=await adminAgents(req,'analytics');return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="GET"&&path.startsWith("/api/admin/agents/")&&path.endsWith("/services")){const userId=decodeURIComponent(path.slice("/api/admin/agents/".length,-"/services".length));const result=await adminAgents(req,'details',userId);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="PATCH"&&path.startsWith("/api/admin/agents/")&&path.endsWith("/services")){const userId=decodeURIComponent(path.slice("/api/admin/agents/".length,-"/services".length));const result=await adminAgents(req,'services',userId);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="PATCH"&&path.startsWith("/api/admin/agents/")&&path.endsWith("/status")){const userId=decodeURIComponent(path.slice("/api/admin/agents/".length,-"/status".length));const result=await adminAgents(req,'status',userId);return send(res,result.success?200:(result.statusCode||400),result);}
if(req.method==="PATCH"&&path.startsWith("/api/admin/agents/")&&path.endsWith("/limits")){const userId=decodeURIComponent(path.slice("/api/admin/agents/".length,-"/limits".length));const result=await adminAgents(req,'limits',userId);return send(res,result.success?200:(result.statusCode||400),result);}
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
b.termsAccepted,
b.ref||b.referralCode
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
  const agent=await getAgentProfile(user.user_id);
  return send(res,200,{success:true,user:{id:user.user_id,userId:user.user_id,name:user.name||"",phone:user.phone||"",email:user.email||"",accountType:agent&&agent.status==='active'?'agent':'customer',agent}});
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


/* ===================== BOLTIV AUTOPAY (v1) =====================
   Scheduled, wallet-paid repeat purchases: airtime, data and cable TV only.
   Every run goes through processVTUTransaction (same pricing, ledger, refunds and cashback as a normal
   purchase). The Transaction PIN is verified once, when the AutoPay is created; runs then skip the PIN
   prompt through an internal function argument (opts.skipPin) that is never read from request data. */
const AUTOPAY_SERVICES=["airtime","data","cable"];
const AUTOPAY_MAX_SCHEDULES=5;
const AUTOPAY_MAX_FAILURES=3;
const AUTOPAY_RUN_HOUR_UTC=6;                 // 07:00 in Nigeria (UTC+1, no daylight saving)
const AUTOPAY_RETRY_MS=30*60*1000;            // one retry, 30 minutes after a provider-side failure
const AUTOPAY_MISSED_MS=6*60*60*1000;         // runs more than 6h late (downtime) are skipped, not fired
const AUTOPAY_MIN_LEAD_MS=12*60*60*1000;      // first run is always at least 12h after creation
const AUTOPAY_LOWBAL_RETRY_HOUR_UTC=17;     // 6:00 PM in Nigeria: one same-day retry when the wallet was too low at 7 AM
const AUTOPAY_MAX_ONCE=10;                       // pending one-time scheduled payments (separate from the 5 repeating AutoPays)
const AUTOPAY_ONCE_MISSED_MS=12*60*60*1000;     // a one-time payment that ran late (downtime) still goes through up to 12h late
const AUTOPAY_ONCE_MIN_LEAD_MS=10*60*1000;      // one-time payments must be at least 10 minutes in the future
let autopayBusy=false;

async function autopayEnabled(){
  const v=await getPlatformSetting("autopay_enabled",true);
  return v!==false&&v!=="false";
}
const autopayMoney=n=>Number(n||0).toLocaleString("en-NG",{minimumFractionDigits:0,maximumFractionDigits:2});
const autopayDateText=d=>new Date(d).toLocaleDateString("en-NG",{weekday:"long",day:"numeric",month:"long",timeZone:"Africa/Lagos"});

const autopayTimeText=d=>new Date(d).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true,timeZone:"Africa/Lagos"});
/* One-time payments: the person picks a date and an hour (Nigeria time, UTC+1, no daylight saving). */
function autopayParseOnce(b){
  const ds=clean(b.onceDate),hour=Number(b.onceHour);
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(ds);
  if(!m||!Number.isInteger(hour)||hour<0||hour>23)return{error:"Choose a date and a time for this payment."};
  const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);
  const chk=new Date(Date.UTC(y,mo-1,d));
  if(chk.getUTCFullYear()!==y||chk.getUTCMonth()!==mo-1||chk.getUTCDate()!==d)return{error:"Choose a valid date."};
  const at=new Date(Date.UTC(y,mo-1,d,hour-1,0,0,0));
  if(at.getTime()<Date.now()+AUTOPAY_ONCE_MIN_LEAD_MS)return{error:"Choose a time at least 10 minutes from now."};
  return{at};
}
function autopayNextRun(frequency,dayOfWeek,dayOfMonth,after){
  const from=after instanceof Date?after:new Date();
  for(let add=0;add<=70;add++){
    const d=new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth(),from.getUTCDate()+add,AUTOPAY_RUN_HOUR_UTC,0,0,0));
    if(d.getTime()<=from.getTime())continue;
    if(frequency==="daily")return d;
    if(frequency==="weekly"){if(d.getUTCDay()===Number(dayOfWeek))return d;}
    else{
      const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
      if(d.getUTCDate()===Math.min(Number(dayOfMonth),last))return d;
    }
  }
  return null;
}
function autopayPublic(s){
  const p=s.payload&&typeof s.payload==="object"?s.payload:{};
  const sc=clean(p.smartcard);
  return{
    id:Number(s.id),service:s.service,label:s.label,frequency:s.frequency,
    dayOfWeek:s.day_of_week==null?null:Number(s.day_of_week),dayOfMonth:s.day_of_month==null?null:Number(s.day_of_month),
    amount:Number(s.amount),maxAmount:s.max_amount==null?Number(s.amount):Number(s.max_amount),status:s.status,pauseReason:s.pause_reason||null,
    nextRunAt:s.next_run_at,lastRunAt:s.last_run_at,lastStatus:s.last_status||null,
    consecutiveFailures:Number(s.consecutive_failures||0),
    recipient:s.service==="cable"?(sc?`Card ending ${sc.slice(-4)}`:""):clean(p.phone),
    network:p.network||p.provider||"",
    planCode:s.service==="data"?clean(p.plan_code):null,
    serviceId:s.service==="data"?Number(p.service_id||0):null,
    planName:s.service==="data"?clean(p.plan_name):s.service==="cable"?clean(p.plan):null,
    priceBlock:s.price_block&&typeof s.price_block==="object"?{kind:s.price_block.kind,amount:s.price_block.amount==null?null:Number(s.price_block.amount),at:s.price_block.at||null}:null
  };
}
/* AutoPay email alerts. Sent only when the in-app notification was newly created (so retries never double-send).
   "AutoPay completed" is not emailed: the normal transaction email already covers a successful run.
   Emails go out one at a time, spaced apart, so a busy 7 AM run stays under Resend's rate limit. */
const AUTOPAY_EMAIL_TITLES=new Set(["AutoPay reminder","AutoPay skipped","AutoPay waiting for funds","AutoPay paused","AutoPay created","AutoPay updated","AutoPay deleted","Scheduled payment created","Scheduled payment failed"]);
let autopayEmailChain=Promise.resolve();
async function autopayEmailSend(userId,title,message,link){
  const r=await db(`SELECT name,email FROM users WHERE user_id=$1 LIMIT 1`,[String(userId)]);
  const u=r.rows[0];
  if(!u?.email)return;
  const result=await sendEmail({
    to:u.email,
    subject:`BOLTIV ${title}`,
    html:`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#171717">
<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:18px;padding:32px;border:1px solid #e7e7e7">
<div style="font-size:28px;font-weight:900;letter-spacing:4px;color:#c49a25;text-align:center">BOLTIV</div>
<h2 style="text-align:center;margin-top:28px">${escapeHtmlEmail(title)}</h2>
<p style="font-size:15px;line-height:1.7;color:#555">Hello ${escapeHtmlEmail(u.name||"BOLTIV User")},</p>
<p style="font-size:15px;line-height:1.7;color:#555">${escapeHtmlEmail(message)}</p>
<p style="text-align:center;margin:26px 0 8px"><a href="https://boltiv.ng${link||"/autopay"}" style="display:inline-block;background:#D4AF37;color:#171717;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:12px">${String(link||"").indexOf("/scheduled-payments")===0?"Open Scheduled Payments":"Open AutoPay"}</a></p>
<p style="font-size:12px;line-height:1.6;color:#999;text-align:center;margin-top:22px">If you did not set up or change this AutoPay, pause it from the AutoPay page and contact BOLTIV support.</p>
</div></body></html>`
  });
  if(!result||!result.success)console.error("AUTOPAY EMAIL NOT SENT:",title,result&&result.message);
}
function autopayEmail(userId,title,message,link){
  autopayEmailChain=autopayEmailChain
    .then(()=>autopayEmailSend(userId,title,message,link))
    .catch(e=>console.error("AUTOPAY EMAIL ERROR:",e?.message||e))
    .then(()=>new Promise(r=>setTimeout(r,600)));
}
async function autopayNotify(userId,title,message,key,link){
  try{
    const added=await addNotificationOnce(userId,title,message,"info",key);
    // pause/resume/delete the user does themselves carry an "autopay-security-" key: no email for those except delete
    const selfAction=/^autopay-security-(pause|resume|pause_all|resume_all)/.test(String(key||""));
    if(added&&AUTOPAY_EMAIL_TITLES.has(title)&&!selfAction)autopayEmail(userId,title,message,link);
  }
  catch(e){console.error("AUTOPAY NOTIFY ERROR:",e?.message||e);}
}
async function autopayAudit(userId,scheduleId,action,details={}){try{await db(`INSERT INTO autopay_audit(user_id,schedule_id,action,details) VALUES($1,$2,$3,$4::jsonb)`,[userId,scheduleId||null,action,JSON.stringify(details||{})]);}catch(e){console.error("AUTOPAY AUDIT ERROR:",e?.message||e);}}

/* ---- validate a create request and build the stored purchase details ---- */
async function autopayBuildPayload(user,b){
  const service=clean(b.service).toLowerCase();
  if(!AUTOPAY_SERVICES.includes(service))return{error:"AutoPay is available for airtime, data and cable TV."};
  const svc=await getService(service);
  if(!svc||svc.enabled===false)return{error:"This service is currently unavailable."};
  if(service==="airtime"){
    const phone=clean(b.phone),network=normalizeDataNetwork(b.network),amount=Number(b.amount);
    if(!/^0\d{10}$/.test(phone))return{error:"Enter a valid 11-digit phone number."};
    if(!network)return{error:"Choose a network."};
    if(!Number.isInteger(amount)||amount<50||amount>50000)return{error:"Airtime amount must be a whole number from ₦50 to ₦50,000."};
    const detected=detectNetworkFromPhone(phone);
    if(detected&&detected!==network&&b.networkConfirmed!==true)return{error:`This number looks like a ${detected} line, but ${network} was selected. Numbers can be ported — confirm the network and try again.`,requiresNetworkConfirmation:true,detectedNetwork:detected};
    return{service,amount,label:`${network} airtime`,payload:{phone,network,amount,networkConfirmed:true},recipientKey:phone};
  }
  if(service==="data"){
    const phone=clean(b.phone),network=normalizeDataNetwork(b.network);
    if(!/^0\d{10}$/.test(phone))return{error:"Enter a valid 11-digit phone number."};
    if(!network)return{error:"Choose a network."};
    const planCode=clean(b.plan_code),serviceId=Number(b.service_id||0),bundleId=clean(b.bundle_id);
    const key=(serviceId>0&&planCode)?planLookupKey(planCode,serviceId):(bundleId||planCode);
    if(!key)return{error:"Choose a data plan."};
    let plan;
    try{plan=await getAuthoritativeVTUGATEDataPlan(network,key);}
    catch(e){return{error:/no longer|unavailable/i.test(e?.message||"")?e.message:"We couldn't load this data plan right now. Please try again."};}
    const planName=clean(plan.name)||clean(b.plan_name)||"Data plan";
    return{service,amount:Number(plan.customer_price),label:`${network} ${planName}`,payload:{phone,network,plan_code:planCode,service_id:serviceId,bundle_id:bundleId,plan_key:key,plan_name:planName},recipientKey:phone};
  }
  const provider=clean(b.provider).toUpperCase(),smartcard=clean(b.smartcard),plan=clean(b.plan);
  if(!provider||!plan)return{error:"Choose a cable provider and plan."};
  if(!/^\d{8,20}$/.test(smartcard))return{error:"Enter a valid smartcard / IUC number."};
  const price=getCablePlanPrice(provider,plan);
  if(price===null)return{error:"That cable TV plan isn't available."};
  let serviceId;
  try{serviceId=await getVTUGATEServiceId("cable",provider);}
  catch(e){return{error:"Network not available. Please try again later.",statusCode:503};}
  const ph=clean(user.phone)||"08000000000";
  const v=await vtugateRequest("api/v1/verifycabletv",{service_id:serviceId,provider,iucnumber:smartcard,smartcard,phone:ph,phone_number:ph,msisdn:ph});
  if(!v.success)return{error:v.message||"We couldn't verify this smartcard / IUC number."};
  const customer=clean(findTransactionField(v.data,["customer_name","customerName","account_name","name"]));
  return{service,amount:price,label:`${provider} ${plan}`,payload:{provider,smartcard,plan,customer_name:customer},recipientKey:smartcard};
}

/* ---- scheduler ---- */
async function autopaySendReminders(){
  const r=await db(`SELECT s.id,s.user_id,s.label,s.amount,s.frequency,s.next_run_at,COALESCE(w.balance,0) AS balance
    FROM autopay_schedules s LEFT JOIN wallets w ON w.user_id=s.user_id
    WHERE s.status='active' AND s.attempt=1 AND s.next_run_at>NOW() AND s.next_run_at<=NOW()+INTERVAL '24 hours'
      AND (s.reminded_for IS NULL OR s.reminded_for<>s.next_run_at) LIMIT 200`);
  for(const s of r.rows){
    if(s.frequency==="daily"&&Number(s.balance)>=Number(s.amount)){ // a reminder every single day would be noise: only warn when the wallet is short
      await db(`UPDATE autopay_schedules SET reminded_for=next_run_at WHERE id=$1 AND next_run_at=$2`,[s.id,s.next_run_at]);
      continue;
    }
    let msg=`Your ${s.frequency==="once"?"scheduled payment":"AutoPay"} for ${s.label} (₦${autopayMoney(s.amount)}) runs ${autopayDateText(s.next_run_at)} at ${autopayTimeText(s.next_run_at)}.`;
    if(Number(s.balance)<Number(s.amount))msg+=` Your wallet balance is ₦${autopayMoney(s.balance)} — please fund your wallet so it doesn't get skipped.`;
    await autopayNotify(s.user_id,"AutoPay reminder",msg,`autopay-remind-${s.id}-${new Date(s.next_run_at).getTime()}`,s.frequency==="once"?"/scheduled-payments":undefined);
    await db(`UPDATE autopay_schedules SET reminded_for=next_run_at WHERE id=$1 AND next_run_at=$2`,[s.id,s.next_run_at]);
  }
}
async function autopayClaim(){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query(`SELECT * FROM autopay_schedules WHERE status='active' AND next_run_at<=NOW() AND (locked_until IS NULL OR locked_until<NOW()) ORDER BY next_run_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if(!r.rows.length){await client.query("COMMIT");return null;}
    await client.query(`UPDATE autopay_schedules SET locked_until=NOW()+INTERVAL '10 minutes' WHERE id=$1`,[r.rows[0].id]);
    await client.query("COMMIT");
    return r.rows[0];
  }catch(e){try{await client.query("ROLLBACK")}catch{};throw e;}
  finally{client.release();}
}
/* Close out one attempt: record it, move the schedule on (or schedule the single retry), and tell the user. */
async function autopayFinish(s,runKey,o){
  const cycle=new Date(s.cycle_for||s.next_run_at);
  await db(`UPDATE autopay_runs SET status=$2,message=$3,transaction_reference=$4,amount=$5,finished_at=NOW() WHERE run_key=$1`,
    [runKey,o.status,String(o.message||"").slice(0,300),o.txRef||null,o.amount!=null?o.amount:Number(s.amount)]);
  await autopayAudit(s.user_id,s.id,"run",{runKey,status:o.status,message:String(o.message||"").slice(0,300),transactionReference:o.txRef||null,amount:o.amount!=null?Number(o.amount):Number(s.amount)});
  if(o.retry){
    const retryAt=o.retryAt instanceof Date?o.retryAt:new Date(Date.now()+AUTOPAY_RETRY_MS);
    await db(`UPDATE autopay_schedules SET attempt=2,next_run_at=$2,locked_until=NULL,updated_at=NOW() WHERE id=$1`,[s.id,retryAt]);
    if(o.retryNotice)await autopayNotify(s.user_id,"AutoPay waiting for funds",o.retryNotice,`autopay-lowbal-${runKey}`,s.frequency==="once"?"/scheduled-payments":undefined);
    return;
  }
  const ok=o.status==="successful"||o.status==="pending";
  if(s.frequency==="once"){
    const doneAmount=o.newAmount!=null?o.newAmount:Number(s.amount);
    if(ok){
      await db(`UPDATE autopay_schedules SET status='deleted',pause_reason='once_done',attempt=1,locked_until=NULL,last_run_at=NOW(),last_status=$2,amount=$3,price_block=NULL,updated_at=NOW() WHERE id=$1`,[s.id,o.status,doneAmount]);
      await autopayNotify(s.user_id,"Scheduled payment completed",`${s.label}: ₦${autopayMoney(doneAmount)} was paid from your wallet.${o.pending?" It is still being confirmed.":""}${o.priceNote?" "+o.priceNote:""}`,`autopay-run-${runKey}`);
    }else{
      await db(`UPDATE autopay_schedules SET status='paused',pause_reason='once_failed',attempt=1,locked_until=NULL,last_run_at=NOW(),last_status=$2,updated_at=NOW() WHERE id=$1`,[s.id,o.status]);
      if(o.priceBlock)await db(`UPDATE autopay_schedules SET price_block=$2::jsonb WHERE id=$1`,[s.id,JSON.stringify(o.priceBlock)]);
      await autopayNotify(s.user_id,"Scheduled payment failed",`${s.label} (₦${autopayMoney(s.amount)}) was not paid: ${o.message}${o.priceBlock?(o.priceBlock.kind==="price"?" Open Scheduled Payments to approve the new price and pay it now.":" Open Scheduled Payments to choose a new plan and time."):" Open Scheduled Payments to reschedule it."}`,`autopay-run-${runKey}`,`/scheduled-payments?fix=${s.id}`);
    }
    return;
  }
  const failures=ok?0:(o.countFailure===false?Number(s.consecutive_failures||0):Number(s.consecutive_failures||0)+1);
  const pause=!ok&&failures>=AUTOPAY_MAX_FAILURES;
  const next=autopayNextRun(s.frequency,s.day_of_week,s.day_of_month,new Date(Math.max(Date.now(),cycle.getTime())));
  const newAmount=o.newAmount!=null?o.newAmount:Number(s.amount);
  await db(`UPDATE autopay_schedules SET status=$2,pause_reason=$3,next_run_at=$4,cycle_for=$4,attempt=1,locked_until=NULL,last_run_at=NOW(),last_status=$5,consecutive_failures=$6,amount=$7,reminded_for=NULL,updated_at=NOW() WHERE id=$1`,
    [s.id,pause?"paused":"active",pause?"failures":null,next,o.status,failures,newAmount]);
  if(o.priceBlock)await db(`UPDATE autopay_schedules SET price_block=$2::jsonb WHERE id=$1`,[s.id,JSON.stringify(o.priceBlock)]);
  else if(ok)await db(`UPDATE autopay_schedules SET price_block=NULL WHERE id=$1 AND price_block IS NOT NULL`,[s.id]);
  const nextText=next?autopayDateText(next):"";
  const key=`autopay-run-${runKey}`;
  if(ok){
    await autopayNotify(s.user_id,"AutoPay completed",`${s.label}: ₦${autopayMoney(newAmount)} was paid from your wallet.${o.pending?" It is still being confirmed.":""}${o.priceNote?" "+o.priceNote:""} Next run: ${nextText}.`,key);
  }else if(pause){
    await autopayNotify(s.user_id,"AutoPay paused",`${s.label} was skipped again (${o.message}) and has been paused after ${AUTOPAY_MAX_FAILURES} missed runs in a row. Fund your wallet, then resume it from the AutoPay page.`,key);
  }else{
    await autopayNotify(s.user_id,"AutoPay skipped",`${s.label} (₦${autopayMoney(newAmount)}) was not run: ${o.message} Next try: ${nextText}.${o.priceBlock?(o.priceBlock.kind==="price"?" Open AutoPay to approve the new price in one tap.":" Open AutoPay to choose a new plan."):""}`,key,o.priceBlock?`/autopay?fix=${s.id}`:undefined);
  }
}
async function autopayProcess(s){
  const scheduledFor=new Date(s.next_run_at);
  const cycle=new Date(s.cycle_for||s.next_run_at);
  const attempt=Number(s.attempt)||1;
  const runKey=`autopay:${s.id}:${cycle.toISOString().slice(0,s.frequency==="once"?16:10)}:${attempt}`;
  const payload=s.payload&&typeof s.payload==="object"?s.payload:{};
  const existing=(await db(`SELECT id,status FROM autopay_runs WHERE run_key=$1`,[runKey])).rows[0];
  if(existing&&existing.status!=="running"){ // this attempt was already handled: just move the schedule on
    await autopayFinish(s,runKey,{status:existing.status==="successful"||existing.status==="pending"?existing.status:"skipped",message:"Already handled.",countFailure:false});
    return;
  }
  if(!existing){
    try{await db(`INSERT INTO autopay_runs(schedule_id,user_id,run_key,scheduled_for,attempt,status,amount) VALUES($1,$2,$3,$4,$5,'running',$6)`,[s.id,s.user_id,runKey,scheduledFor,attempt,Number(s.amount)]);}
    catch(e){if(e.code!=="23505")throw e;}
  }
  // 1) ran too late (e.g. the server was down at 7am): skip instead of buying at a surprise time
  if(attempt===1&&Date.now()-scheduledFor.getTime()>(s.frequency==="once"?AUTOPAY_ONCE_MISSED_MS:AUTOPAY_MISSED_MS)){
    return autopayFinish(s,runKey,{status:"skipped",message:"BOLTIV was unavailable at the scheduled time.",countFailure:false});
  }
  // 2) account / agent checks
  const u=(await db(`SELECT id,user_id,name,phone,email,status FROM users WHERE user_id=$1 LIMIT 1`,[s.user_id])).rows[0];
  if(!u||u.status!=="active"){
    await db(`UPDATE autopay_runs SET status='skipped',message='Account not active.',finished_at=NOW() WHERE run_key=$1`,[runKey]);
    await db(`UPDATE autopay_schedules SET status='paused',pause_reason='account',locked_until=NULL,updated_at=NOW() WHERE id=$1`,[s.id]);
    return;
  }
  const agent=await getEffectiveAgentService(s.user_id,s.service);
  if(agent.isAgent){
    await db(`UPDATE autopay_runs SET status='skipped',message='AutoPay is not available for agent accounts.',finished_at=NOW() WHERE run_key=$1`,[runKey]);
    await db(`UPDATE autopay_schedules SET status='paused',pause_reason='agent',locked_until=NULL,updated_at=NOW() WHERE id=$1`,[s.id]);
    await autopayNotify(s.user_id,"AutoPay paused","AutoPay is only available for regular customer accounts, so your AutoPay has been paused.",`autopay-agent-${s.id}`);
    return;
  }
  const canRetry=attempt===1;
  const retryOrFail=(message)=>canRetry
    ?autopayFinish(s,runKey,{status:"failed",message,retry:true})
    :autopayFinish(s,runKey,{status:"failed",message});
  // 3) service switched off / in maintenance
  const svc=await getService(s.service);
  if(!svc||svc.enabled===false||svc.maintenance===true)return retryOrFail("this service is temporarily unavailable.");
  // 4) rebuild the purchase at today's price
  let amount=Number(s.amount),data;
  if(s.service==="airtime"){
    data={service:"airtime",phone:payload.phone,network:payload.network,amount,airtime_amount:amount,networkConfirmed:true};
  }else if(s.service==="data"){
    let plan;
    try{plan=await getAuthoritativeVTUGATEDataPlan(payload.network,payload.plan_key||planLookupKey(payload.plan_code,payload.service_id));}
    catch(e){
      const m=String(e?.message||"");
      if(/no longer available|Invalid data plan/i.test(m))return autopayFinish(s,runKey,{status:"skipped",message:"this data plan is no longer available.",priceBlock:{kind:"plan",at:new Date().toISOString()}});
      return retryOrFail("the data service could not be reached.");
    }
    amount=Number(plan.customer_price);
    data={service:"data",phone:payload.phone,network:payload.network,plan_code:payload.plan_code,service_id:payload.service_id,bundle_id:payload.bundle_id,plan_name:clean(plan.name)||payload.plan_name,amount};
  }else{
    const price=getCablePlanPrice(payload.provider,payload.plan);
    if(price===null)return autopayFinish(s,runKey,{status:"skipped",message:"this cable TV plan is no longer available.",priceBlock:{kind:"plan",at:new Date().toISOString()}});
    amount=price;
    data={service:"cable",provider:payload.provider,smartcard:payload.smartcard,plan:payload.plan,amount};
  }
  const priceNote=Math.abs(amount-Number(s.amount))>0.009?`The price changed from ₦${autopayMoney(s.amount)} to ₦${autopayMoney(amount)}.`:"";
  // 5) customer price protection: never silently charge above the user's chosen limit.
  const maxAmount=Number(s.max_amount==null?s.amount:s.max_amount);
  if(amount>maxAmount+0.009){
    return autopayFinish(s,runKey,{status:"skipped",message:`the current price is ₦${autopayMoney(amount)}, above your ₦${autopayMoney(maxAmount)} AutoPay limit.`,amount,countFailure:false,priceNote,priceBlock:{kind:"price",amount,at:new Date().toISOString()}});
  }
  // 6) enough money? (the purchase itself re-checks atomically)
  const wallet=await getWallet(s.user_id);
  if(Number(wallet?.balance||0)<amount){
    if(canRetry){ // first attempt: wait for the user to top up and try once more this evening (not counted as a missed run)
      const retryAt=new Date(Math.max(Date.UTC(scheduledFor.getUTCFullYear(),scheduledFor.getUTCMonth(),scheduledFor.getUTCDate(),AUTOPAY_LOWBAL_RETRY_HOUR_UTC,0,0,0),Date.now()+AUTOPAY_RETRY_MS));
      return autopayFinish(s,runKey,{status:"skipped",message:"your wallet balance is too low.",amount,newAmount:amount,retry:true,retryAt,
        retryNotice:`${s.label} (₦${autopayMoney(amount)}) could not run because your wallet balance is too low. We'll try once more at ${autopayTimeText(retryAt)} — fund your wallet before then and it will go through.`});
    }
    return autopayFinish(s,runKey,{status:"skipped",message:"your wallet balance is too low.",amount,newAmount:amount});
  }
  data.providerPayload={...data};
  data.idempotencyKey=runKey;
  let result;
  try{result=await processVTUTransaction(u,data,{skipPin:true,autopay:{schedule_id:Number(s.id),run_key:runKey,once:s.frequency==="once"}});}
  catch(e){
    console.error("AUTOPAY PURCHASE ERROR:",e?.stack||e?.message||e);
    // unknown outcome: never retry (could double-charge) — the purchase reconciliation job settles it
    return autopayFinish(s,runKey,{status:"pending",message:"Result being confirmed.",pending:true,amount,newAmount:amount,priceNote});
  }
  if(result.success&&["successful","pending","processing"].includes(result.status)){
    const st=result.status==="successful"?"successful":"pending";
    return autopayFinish(s,runKey,{status:st,message:result.message,txRef:result.reference,amount,newAmount:amount,pending:st==="pending",priceNote});
  }
  if(result.status==="refunded"||Number(result.statusCode)===503||Number(result.statusCode)===502){
    return retryOrFail(result.status==="refunded"?"the provider could not complete it and your wallet was refunded.":"the provider is unavailable right now.");
  }
  const insufficient=/insufficient/i.test(result.message||"");
  return autopayFinish(s,runKey,{status:"skipped",message:insufficient?"your wallet balance is too low.":String(result.message||"it could not be completed.").replace(/\.$/,"")+".",amount,newAmount:amount});
}
/* Current price of a saved data/cable AutoPay, read the same way a real run reads it. */
async function autopayFreshPrice(cur){
  const p=cur.payload&&typeof cur.payload==="object"?cur.payload:{};
  if(cur.service==="data"){
    try{const plan=await getAuthoritativeVTUGATEDataPlan(p.network,p.plan_key||planLookupKey(p.plan_code,p.service_id));return{price:Number(plan.customer_price)};}
    catch(e){return{error:true,gone:/no longer available|Invalid data plan/i.test(String(e?.message||""))};}
  }
  if(cur.service==="cable"){const price=getCablePlanPrice(p.provider,p.plan);return price===null?{error:true,gone:true}:{price:Number(price)};}
  return{price:Number(cur.amount)};
}
async function autopayTick(){
  if(autopayBusy)return;
  autopayBusy=true;
  try{
    if(!(await autopayEnabled()))return;
    await autopaySendReminders();
    for(let i=0;i<25;i++){
      const job=await autopayClaim();
      if(!job)break;
      try{await autopayProcess(job);}
      catch(e){
        console.error("AUTOPAY RUN ERROR:",e?.stack||e?.message||e);
        try{await db(`UPDATE autopay_schedules SET locked_until=NOW()+INTERVAL '10 minutes' WHERE id=$1`,[job.id]);}catch{}
      }
    }
  }catch(e){console.error("AUTOPAY TICK ERROR:",e?.stack||e?.message||e);}
  finally{autopayBusy=false;}
}

/* ---- routes ---- */
async function handleAutopayRoutes(req,res,path,user){
  if(req.method==="GET"&&path==="/api/autopay"){
    const [sch,runs,cb,wallet,enabled]=await Promise.all([
      db(`SELECT * FROM autopay_schedules WHERE user_id=$1 AND status<>'deleted' ORDER BY created_at DESC`,[user.user_id]),
      db(`SELECT r.id,r.status,r.message,r.amount,r.scheduled_for,r.finished_at,r.attempt,s.label,s.service,s.frequency,COALESCE(bl.amount,0) AS cashback
          FROM autopay_runs r JOIN autopay_schedules s ON s.id=r.schedule_id
          LEFT JOIN bonus_lots bl ON bl.source_reference='CASHBACK-'||r.transaction_reference AND bl.status<>'reversed'
          WHERE r.user_id=$1 AND r.status<>'running' ORDER BY r.created_at DESC LIMIT 100`,[user.user_id]),
      db(`SELECT COALESCE(SUM(bl.amount),0) AS total FROM bonus_lots bl JOIN autopay_runs r ON bl.source_reference='CASHBACK-'||r.transaction_reference WHERE r.user_id=$1 AND bl.status<>'reversed'`,[user.user_id]),
      getWallet(user.user_id),
      autopayEnabled()
    ]);
    send(res,200,{success:true,enabled,maxSchedules:AUTOPAY_MAX_SCHEDULES,maxOnce:AUTOPAY_MAX_ONCE,walletBalance:Number(wallet?.balance||0),
      cashbackEarned:Number(cb.rows[0]?.total||0),
      schedules:sch.rows.map(autopayPublic),
      runs:runs.rows.map(r=>({id:Number(r.id),status:r.status,message:r.message,amount:r.amount==null?null:Number(r.amount),scheduledFor:r.scheduled_for,finishedAt:r.finished_at,label:r.label,service:r.service,frequency:r.frequency,cashback:Number(r.cashback||0)}))});
    return true;
  }
  if(req.method==="POST"&&path==="/api/autopay/create"){
    const rl=rateLimit(req,`autopay-create:${user.user_id}`,8,15*60*1000);
    if(!rl.allowed){rateLimitedResponse(res,rl);return true;}
    const b=await body(req);
    if(!(await autopayEnabled())){send(res,503,{success:false,message:"AutoPay is not available right now."});return true;}
    const pin=clean(b.transactionPin);
    if(!/^\d{4}$/.test(pin)){send(res,400,{success:false,message:"Enter your 4-digit Transaction PIN."});return true;}
    const security=await getSecurity(user.user_id);
    if(!security?.transaction_pin_hash){send(res,400,{success:false,message:"Please set your Transaction PIN before creating an AutoPay."});return true;}
    if(!verifyPassword(pin,security.transaction_pin_hash)){send(res,400,{success:false,message:"Incorrect Transaction PIN."});return true;}
    const service=clean(b.service).toLowerCase();
    const agent=await getEffectiveAgentService(user.user_id,AUTOPAY_SERVICES.includes(service)?service:"airtime");
    if(agent.isAgent){send(res,403,{success:false,message:"AutoPay is only available for regular customer accounts."});return true;}
    const frequency=clean(b.frequency).toLowerCase();
    const dow=Number(b.dayOfWeek),dom=Number(b.dayOfMonth);
    if(!["once","daily","weekly","monthly"].includes(frequency)){send(res,400,{success:false,message:"Choose once, daily, weekly or monthly."});return true;}
    if(frequency==="daily"&&service==="cable"){send(res,400,{success:false,message:"Daily AutoPay is available for airtime and data only."});return true;}
    if(frequency==="weekly"&&!(Number.isInteger(dow)&&dow>=0&&dow<=6)){send(res,400,{success:false,message:"Choose a day of the week."});return true;}
    if(frequency==="monthly"&&!(Number.isInteger(dom)&&dom>=1&&dom<=31)){send(res,400,{success:false,message:"Choose a day of the month (1–31)."});return true;}
    const isOnce=frequency==="once";
    let onceAt=null;
    if(isOnce){const po=autopayParseOnce(b);if(po.error){send(res,400,{success:false,message:po.error});return true;}onceAt=po.at;}
    const count=await db(`SELECT COUNT(*)::int AS n FROM autopay_schedules WHERE user_id=$1 AND status<>'deleted' AND (frequency='once')=$2`,[user.user_id,isOnce]);
    const limitN=isOnce?AUTOPAY_MAX_ONCE:AUTOPAY_MAX_SCHEDULES;
    if(count.rows[0].n>=limitN){send(res,400,{success:false,message:isOnce?`You can have up to ${limitN} scheduled payments. Delete one to add another.`:`You can have up to ${limitN} AutoPays. Delete one to add another.`});return true;}
    const built=await autopayBuildPayload(user,b);
    if(built.error){send(res,built.statusCode||400,{success:false,message:built.error,requiresNetworkConfirmation:built.requiresNetworkConfirmation||false,detectedNetwork:built.detectedNetwork||undefined});return true;}
    const maxAmount=Number(b.maxAmount);
    if(!Number.isFinite(maxAmount)||maxAmount<Number(built.amount)||maxAmount>1000000){send(res,400,{success:false,message:`Set a maximum payment of at least ₦${autopayMoney(built.amount)} and no more than ₦1,000,000.`});return true;}
    const dup=isOnce?await db(`SELECT id FROM autopay_schedules WHERE user_id=$1 AND status<>'deleted' AND service=$2 AND label=$3 AND frequency='once' AND next_run_at=$4 AND (payload->>'phone'=$5 OR payload->>'smartcard'=$5) LIMIT 1`,[user.user_id,built.service,built.label,onceAt,built.recipientKey]):await db(`SELECT id FROM autopay_schedules WHERE user_id=$1 AND status<>'deleted' AND service=$2 AND label=$3 AND frequency=$4 AND COALESCE(day_of_week,-1)=$5 AND COALESCE(day_of_month,-1)=$6 AND (payload->>'phone'=$7 OR payload->>'smartcard'=$7) LIMIT 1`,
      [user.user_id,built.service,built.label,frequency,frequency==="weekly"?dow:-1,frequency==="monthly"?dom:-1,built.recipientKey]);
    if(dup.rows.length){send(res,400,{success:false,message:"You already have this AutoPay."});return true;}
    const next=isOnce?onceAt:autopayNextRun(frequency,dow,dom,new Date(Date.now()+AUTOPAY_MIN_LEAD_MS));
    if(!next){send(res,400,{success:false,message:"Could not work out the next run date."});return true;}
    const reminded=(next.getTime()-Date.now())<=24*60*60*1000?next:null;
    const ins=await db(`INSERT INTO autopay_schedules(user_id,service,label,frequency,day_of_week,day_of_month,amount,max_amount,payload,status,next_run_at,cycle_for,reminded_for)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'active',$10,$10,$11) RETURNING *`,
      [user.user_id,built.service,built.label,frequency,frequency==="weekly"?dow:null,frequency==="monthly"?dom:null,built.amount,maxAmount,JSON.stringify(built.payload),next,reminded]);
    try{await autopayNotify(user.user_id,isOnce?"Scheduled payment created":"AutoPay created",isOnce?`${built.label} (₦${autopayMoney(built.amount)}, max ₦${autopayMoney(maxAmount)}) will be paid once on ${autopayDateText(next)} at ${autopayTimeText(next)} from your wallet.`:`${built.label} (₦${autopayMoney(built.amount)}, max ₦${autopayMoney(maxAmount)}) will run ${frequency==="daily"?"every day":frequency==="weekly"?"every week":"every month"}. First run: ${autopayDateText(next)} at 7:00 AM from your wallet.`,"",isOnce?"/scheduled-payments":undefined);}catch{}
    await autopayAudit(user.user_id,ins.rows[0].id,"created",{service:built.service,amount:Number(built.amount),maxAmount,frequency});
    send(res,200,{success:true,message:"AutoPay created.",schedule:autopayPublic(ins.rows[0])});
    return true;
  }
  if(req.method==="POST"&&path==="/api/autopay/edit"){
    const rl=rateLimit(req,`autopay-edit:${user.user_id}`,20,15*60*1000);if(!rl.allowed){rateLimitedResponse(res,rl);return true;}
    const b=await body(req),id=Number(b.id);if(!(id>0)){send(res,400,{success:false,message:"Invalid AutoPay."});return true;}
    if(!(await autopayEnabled())){send(res,503,{success:false,message:"AutoPay is not available right now."});return true;}
    const cur=(await db(`SELECT * FROM autopay_schedules WHERE id=$1 AND user_id=$2 AND status<>'deleted'`,[id,user.user_id])).rows[0];if(!cur){send(res,404,{success:false,message:"AutoPay not found."});return true;}
    const pin=clean(b.transactionPin);if(!/^\d{4}$/.test(pin)){send(res,400,{success:false,message:"Enter your 4-digit Transaction PIN."});return true;}
    const security=await getSecurity(user.user_id);if(!security?.transaction_pin_hash||!verifyPassword(pin,security.transaction_pin_hash)){send(res,400,{success:false,message:"Incorrect Transaction PIN."});return true;}
    const service=clean(b.service).toLowerCase();if(service!==cur.service){send(res,400,{success:false,message:"The AutoPay service cannot be changed. Edit its plan, amount or schedule instead."});return true;}
    const frequency=clean(b.frequency).toLowerCase(),dow=Number(b.dayOfWeek),dom=Number(b.dayOfMonth);
    if(!["once","daily","weekly","monthly"].includes(frequency)){send(res,400,{success:false,message:"Choose once, daily, weekly or monthly."});return true;}
    if(frequency==="daily"&&service==="cable"){send(res,400,{success:false,message:"Daily AutoPay is available for airtime and data only."});return true;}
    if(frequency==="weekly"&&!(Number.isInteger(dow)&&dow>=0&&dow<=6)){send(res,400,{success:false,message:"Choose a day of the week."});return true;}
    if(frequency==="monthly"&&!(Number.isInteger(dom)&&dom>=1&&dom<=31)){send(res,400,{success:false,message:"Choose a day of the month (1–31)."});return true;}
    const isOnceEdit=frequency==="once";
    if(isOnceEdit!==(cur.frequency==="once")){send(res,400,{success:false,message:"To switch between a one-time payment and a repeating AutoPay, create a new one."});return true;}
    let onceAt=null;
    if(isOnceEdit){const po=autopayParseOnce(b);if(po.error){send(res,400,{success:false,message:po.error});return true;}onceAt=po.at;}
    const editInput={...b};if(service==="cable"&&(b.useExistingRecipient===true||!clean(editInput.smartcard)))editInput.smartcard=clean(cur.payload?.smartcard);
    const built=await autopayBuildPayload(user,editInput);if(built.error){send(res,built.statusCode||400,{success:false,message:built.error,requiresNetworkConfirmation:built.requiresNetworkConfirmation||false,detectedNetwork:built.detectedNetwork||undefined});return true;}
    const maxAmount=Number(b.maxAmount);
    if(!Number.isFinite(maxAmount)||maxAmount<Number(built.amount)||maxAmount>1000000){send(res,400,{success:false,message:`Set a maximum payment of at least ₦${autopayMoney(built.amount)} and no more than ₦1,000,000.`});return true;}
    const dup=isOnceEdit?await db(`SELECT id FROM autopay_schedules WHERE user_id=$1 AND id<>$2 AND status<>'deleted' AND service=$3 AND label=$4 AND frequency='once' AND next_run_at=$5 AND (payload->>'phone'=$6 OR payload->>'smartcard'=$6) LIMIT 1`,[user.user_id,id,built.service,built.label,onceAt,built.recipientKey]):await db(`SELECT id FROM autopay_schedules WHERE user_id=$1 AND id<>$2 AND status<>'deleted' AND service=$3 AND label=$4 AND frequency=$5 AND COALESCE(day_of_week,-1)=$6 AND COALESCE(day_of_month,-1)=$7 AND (payload->>'phone'=$8 OR payload->>'smartcard'=$8) LIMIT 1`,[user.user_id,id,built.service,built.label,frequency,frequency==="weekly"?dow:-1,frequency==="monthly"?dom:-1,built.recipientKey]);if(dup.rows.length){send(res,400,{success:false,message:"You already have this AutoPay."});return true;}
    const next=isOnceEdit?onceAt:autopayNextRun(frequency,dow,dom,new Date(Date.now()+AUTOPAY_MIN_LEAD_MS));if(!next){send(res,400,{success:false,message:"Could not work out the next run date."});return true;}
    const reminded=(next.getTime()-Date.now())<=24*60*60*1000?next:null;
    const upd=await db(`UPDATE autopay_schedules SET frequency=$2,day_of_week=$3,day_of_month=$4,amount=$5,max_amount=$6,payload=$7::jsonb,label=$8,next_run_at=$9,cycle_for=$9,attempt=1,locked_until=NULL,reminded_for=$10,price_block=NULL,status=CASE WHEN pause_reason='once_failed' THEN 'active' ELSE status END,pause_reason=CASE WHEN pause_reason='once_failed' THEN NULL ELSE pause_reason END,updated_at=NOW() WHERE id=$1 RETURNING *`,[id,frequency,frequency==="weekly"?dow:null,frequency==="monthly"?dom:null,built.amount,maxAmount,JSON.stringify(built.payload),built.label,next,reminded]);
    await autopayAudit(user.user_id,id,"edited",{service:built.service,frequency,amount:Number(built.amount),maxAmount,label:built.label});
    await autopayNotify(user.user_id,"AutoPay updated",`${built.label} was updated. ${isOnceEdit?"It will be paid":"Next run:"} ${autopayDateText(next)} at ${autopayTimeText(next)}.`,`autopay-security-edit-${id}-${next.getTime()}`,isOnceEdit?"/scheduled-payments":undefined);
    send(res,200,{success:true,message:"AutoPay updated.",schedule:autopayPublic(upd.rows[0])});return true;
  }
  if(req.method==="POST"&&path==="/api/autopay/bulk-action"){
    const rl=rateLimit(req,`autopay-bulk:${user.user_id}`,10,15*60*1000);if(!rl.allowed){rateLimitedResponse(res,rl);return true;}
    const b=await body(req),action=clean(b.action).toLowerCase();if(!["pause_all","resume_all"].includes(action)){send(res,400,{success:false,message:"Invalid request."});return true;}
    if(action==="resume_all"&&!(await autopayEnabled())){send(res,503,{success:false,message:"AutoPay is not available right now."});return true;}
    const rows=(await db(`SELECT * FROM autopay_schedules WHERE user_id=$1 AND status<>'deleted' AND frequency<>'once' ORDER BY id ASC`,[user.user_id])).rows;let changed=0;
    for(const cur of rows){
      if(action==="pause_all"){if(cur.status!=="paused"){await db(`UPDATE autopay_schedules SET status='paused',pause_reason='user',locked_until=NULL,updated_at=NOW() WHERE id=$1`,[cur.id]);changed++;await autopayAudit(user.user_id,cur.id,"paused_all",{});}}
      else if(cur.status!=="active"){const agent=await getEffectiveAgentService(user.user_id,cur.service);if(agent.isAgent)continue;if(cur.frequency==="once"&&new Date(cur.next_run_at).getTime()<Date.now()+AUTOPAY_ONCE_MIN_LEAD_MS)continue;const next=cur.frequency==="once"?new Date(cur.next_run_at):autopayNextRun(cur.frequency,cur.day_of_week,cur.day_of_month,new Date(Date.now()+AUTOPAY_MIN_LEAD_MS));const reminded=next&&(next.getTime()-Date.now())<=24*60*60*1000?next:null;await db(`UPDATE autopay_schedules SET status='active',pause_reason=NULL,consecutive_failures=0,attempt=1,locked_until=NULL,next_run_at=$2,cycle_for=$2,reminded_for=$3,updated_at=NOW() WHERE id=$1`,[cur.id,next,reminded]);changed++;await autopayAudit(user.user_id,cur.id,"resumed_all",{nextRunAt:next});}
    }
    await autopayNotify(user.user_id,action==="pause_all"?"All AutoPays paused":"All AutoPays resumed",`${changed} AutoPay${changed===1?"":"s"} ${action==="pause_all"?"paused":"resumed"}.`, `autopay-security-${action}-${Date.now()}`);send(res,200,{success:true,changed});return true;
  }
  if(req.method==="POST"&&path==="/api/autopay/approve-price"){
    const rl=rateLimit(req,`autopay-approve:${user.user_id}`,10,15*60*1000);if(!rl.allowed){rateLimitedResponse(res,rl);return true;}
    if(!(await autopayEnabled())){send(res,503,{success:false,message:"AutoPay is not available right now."});return true;}
    const b=await body(req),id=Number(b.id);
    if(!(id>0)){send(res,400,{success:false,message:"Invalid AutoPay."});return true;}
    const pin=clean(b.transactionPin);if(!/^\d{4}$/.test(pin)){send(res,400,{success:false,message:"Enter your 4-digit Transaction PIN."});return true;}
    const security=await getSecurity(user.user_id);
    if(!security?.transaction_pin_hash||!verifyPassword(pin,security.transaction_pin_hash)){send(res,400,{success:false,message:"Incorrect Transaction PIN."});return true;}
    const cur=(await db(`SELECT * FROM autopay_schedules WHERE id=$1 AND user_id=$2 AND status<>'deleted'`,[id,user.user_id])).rows[0];
    if(!cur){send(res,404,{success:false,message:"AutoPay not found."});return true;}
    const block=cur.price_block;
    if(!block||block.kind!=="price"){send(res,400,{success:false,message:"There is no new price waiting for your approval."});return true;}
    const agent=await getEffectiveAgentService(user.user_id,cur.service);
    if(agent.isAgent){send(res,403,{success:false,message:"AutoPay is only available for regular customer accounts."});return true;}
    const fresh=await autopayFreshPrice(cur);
    if(fresh.error){send(res,409,{success:false,message:fresh.gone?"This plan is no longer available. Edit the AutoPay to choose a new plan.":"We couldn't check the current price. Please try again in a moment."});return true;}
    const price=Number(fresh.price);
    if(!(price>0)){send(res,400,{success:false,message:"We couldn't read the current price. Please try again."});return true;}
    const newLimit=Math.min(1000000,Math.max(price,Math.ceil(price*1.10/50)*50,Number(cur.max_amount||0)));
    const wallet=await getWallet(user.user_id);
    const within=cur.frequency==="once"||block.at&&(cur.frequency==="daily"?new Date(block.at).toISOString().slice(0,10)===new Date().toISOString().slice(0,10):(Date.now()-new Date(block.at).getTime())<24*60*60*1000);
    const runNow=Boolean(within&&(cur.status==="active"||cur.pause_reason==="once_failed")&&Number(wallet?.balance||0)>=price);
    await db(`UPDATE autopay_schedules SET max_amount=$2,amount=$3,price_block=NULL,updated_at=NOW() WHERE id=$1`,[id,newLimit,price]);
    await autopayAudit(user.user_id,id,"price_approved",{price,newLimit,runNow});
    await autopayNotify(user.user_id,"AutoPay updated",`${cur.label}: the new price of ₦${autopayMoney(price)} was approved and your limit is now ₦${autopayMoney(newLimit)}.${runNow?" Buying it now.":cur.frequency==="once"?" Fund your wallet, then reschedule it from the AutoPay page.":" It will run on its next scheduled date."}`,`autopay-security-approve-${id}-${Date.now()}`);
    if(runNow){
      const row=(await db(`UPDATE autopay_schedules SET status='active',pause_reason=NULL,next_run_at=NOW(),cycle_for=NOW(),attempt=3,locked_until=NOW()+INTERVAL '10 minutes',reminded_for=NULL,updated_at=NOW() WHERE id=$1 AND (status='active' OR pause_reason='once_failed') RETURNING *`,[id])).rows[0];
      if(row)autopayProcess(row).catch(e=>console.error("AUTOPAY APPROVE RUN ERROR:",e?.stack||e?.message||e));
    }
    send(res,200,{success:true,price,newLimit,runNow});return true;
  }
  if(req.method==="POST"&&path==="/api/autopay/action"){
    const rl=rateLimit(req,`autopay-action:${user.user_id}`,30,15*60*1000);
    if(!rl.allowed){rateLimitedResponse(res,rl);return true;}
    const b=await body(req);
    const id=Number(b.id),action=clean(b.action).toLowerCase();
    if(!(id>0)||!["pause","resume","delete"].includes(action)){send(res,400,{success:false,message:"Invalid request."});return true;}
    const cur=(await db(`SELECT * FROM autopay_schedules WHERE id=$1 AND user_id=$2 AND status<>'deleted'`,[id,user.user_id])).rows[0];
    if(!cur){send(res,404,{success:false,message:"AutoPay not found."});return true;}
    if(action==="pause"){
      await db(`UPDATE autopay_schedules SET status='paused',pause_reason='user',updated_at=NOW() WHERE id=$1`,[id]);
      await autopayAudit(user.user_id,id,"paused",{});await autopayNotify(user.user_id,"AutoPay paused",`${cur.label} was paused.`,`autopay-security-pause-${id}-${Date.now()}`);
    }else if(action==="delete"){
      await db(`UPDATE autopay_schedules SET status='deleted',updated_at=NOW() WHERE id=$1`,[id]);
      await autopayAudit(user.user_id,id,"deleted",{});await autopayNotify(user.user_id,"AutoPay deleted",cur.frequency==="once"?`${cur.label} scheduled payment was cancelled and will not be paid.`:`${cur.label} was deleted and will no longer run.`,`autopay-security-delete-${id}-${Date.now()}`,cur.frequency==="once"?"/scheduled-payments":undefined);
    }else{
      if(!(await autopayEnabled())){send(res,503,{success:false,message:"AutoPay is not available right now."});return true;}
      const agent=await getEffectiveAgentService(user.user_id,cur.service);
      if(agent.isAgent){send(res,403,{success:false,message:"AutoPay is only available for regular customer accounts."});return true;}
      if(cur.frequency==="once"&&new Date(cur.next_run_at).getTime()<Date.now()+AUTOPAY_ONCE_MIN_LEAD_MS){send(res,400,{success:false,message:"The time for this scheduled payment has passed. Edit it to choose a new time."});return true;}
      const next=cur.frequency==="once"?new Date(cur.next_run_at):autopayNextRun(cur.frequency,cur.day_of_week,cur.day_of_month,new Date(Date.now()+AUTOPAY_MIN_LEAD_MS));
      const reminded=next&&(next.getTime()-Date.now())<=24*60*60*1000?next:null;
      await db(`UPDATE autopay_schedules SET status='active',pause_reason=NULL,consecutive_failures=0,attempt=1,locked_until=NULL,next_run_at=$2,cycle_for=$2,reminded_for=$3,updated_at=NOW() WHERE id=$1`,[id,next,reminded]);
      await autopayAudit(user.user_id,id,"resumed",{nextRunAt:next});await autopayNotify(user.user_id,"AutoPay resumed",`${cur.label} was resumed. ${cur.frequency==="once"?"It will be paid":"Next run:"} ${autopayDateText(next)} at ${autopayTimeText(next)}.`,`autopay-security-resume-${id}-${next.getTime()}`);
    }
    const fresh=(await db(`SELECT * FROM autopay_schedules WHERE id=$1`,[id])).rows[0];
    send(res,200,{success:true,schedule:autopayPublic(fresh)});
    return true;
  }
  return false;
}

/* ===================== BOLTIV FAVORITES (saved numbers & smartcards) ===================== */
const FAVORITES_MAX=20;
const favoritePublic=r=>({id:Number(r.id),kind:r.kind,name:r.name,recipient:r.recipient,network:r.network||"",provider:r.provider||""});
async function handleFavoritesRoutes(req,res,path,user){
  if(req.method==="GET"&&path==="/api/favorites"){
    const r=await db(`SELECT id,kind,name,recipient,network,provider FROM user_favorites WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100`,[user.user_id]);
    send(res,200,{success:true,max:FAVORITES_MAX,favorites:r.rows.map(favoritePublic)});return true;
  }
  if(req.method==="POST"&&path==="/api/favorites"){
    const rl=rateLimit(req,`favorites-save:${user.user_id}`,30,15*60*1000);
    if(!rl.allowed){rateLimitedResponse(res,rl);return true;}
    const b=await body(req);
    const kind=clean(b.kind).toLowerCase();
    const name=clean(b.name).replace(/\s+/g," ").slice(0,30);
    const recipient=clean(b.recipient).replace(/\s+/g,"");
    if(!["phone","cable"].includes(kind)){send(res,400,{success:false,message:"Invalid saved item."});return true;}
    if(!name){send(res,400,{success:false,message:"Enter a name for this saved number."});return true;}
    if(kind==="phone"&&!/^0\d{10}$/.test(recipient)){send(res,400,{success:false,message:"Enter a valid 11-digit phone number."});return true;}
    if(kind==="cable"&&!/^\d{8,20}$/.test(recipient)){send(res,400,{success:false,message:"Enter a valid smartcard / IUC number."});return true;}
    const network=kind==="phone"?(normalizeDataNetwork(b.network)||null):null;
    const provider=kind==="cable"?clean(b.provider).toUpperCase():null;
    if(kind==="cable"&&!["DSTV","GOTV"].includes(provider)){send(res,400,{success:false,message:"Choose a cable provider."});return true;}
    const exists=(await db(`SELECT id FROM user_favorites WHERE user_id=$1 AND kind=$2 AND recipient=$3`,[user.user_id,kind,recipient])).rows[0];
    if(!exists){
      const n=(await db(`SELECT COUNT(*)::int AS n FROM user_favorites WHERE user_id=$1`,[user.user_id])).rows[0].n;
      if(n>=FAVORITES_MAX){send(res,400,{success:false,message:`You can save up to ${FAVORITES_MAX} numbers. Remove one to add another.`});return true;}
    }
    const ins=await db(`INSERT INTO user_favorites(user_id,kind,name,recipient,network,provider) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(user_id,kind,recipient) DO UPDATE SET name=EXCLUDED.name,network=EXCLUDED.network,provider=EXCLUDED.provider,updated_at=NOW()
      RETURNING id,kind,name,recipient,network,provider`,[user.user_id,kind,name,recipient,network,provider]);
    send(res,200,{success:true,favorite:favoritePublic(ins.rows[0])});return true;
  }
  if(req.method==="POST"&&path==="/api/favorites/delete"){
    const rl=rateLimit(req,`favorites-delete:${user.user_id}`,60,15*60*1000);
    if(!rl.allowed){rateLimitedResponse(res,rl);return true;}
    const b=await body(req),id=Number(b.id);
    if(!(id>0)){send(res,400,{success:false,message:"Invalid saved item."});return true;}
    await db(`DELETE FROM user_favorites WHERE id=$1 AND user_id=$2`,[id,user.user_id]);
    send(res,200,{success:true});return true;
  }
  return false;
}

/* ===================== DATA EXPIRY REMINDERS =====================
   One in-app reminder per successful data purchase whose plan lasts a week or more, a few days before it ends.
   Skipped when the same number already bought again, or when the purchase came from AutoPay. */
const DATA_REMIND_MIN_DAYS=7;
let dataExpiryBusy=false;
function dataValidityDays(meta){
  const p=(meta&&meta.pricing)||{};
  const v=Number(p.validityDays);
  if(Number.isFinite(v)&&v>0)return v;
  const name=String(p.plan||(meta&&(meta.plan||meta.plan_name))||(meta&&meta.request&&meta.request.plan_name)||"");
  const m=name.match(/(\d+)\s*-?\s*days?\b/i);
  return m?Number(m[1]):0;
}
async function dataExpirySweep(){
  if(dataExpiryBusy)return;
  dataExpiryBusy=true;
  try{
    const r=await db(`SELECT id,user_id,recipient,metadata,COALESCE(completed_at,date) AS bought_at
      FROM transactions
      WHERE service='data' AND status='successful' AND recipient IS NOT NULL
        AND COALESCE(completed_at,date)>NOW()-INTERVAL '100 days' AND COALESCE(completed_at,date)<NOW()-INTERVAL '2 days'
        AND (metadata->'autopay') IS NULL
      ORDER BY id DESC LIMIT 3000`);
    const DAY=86400000,now=Date.now();
    for(const t of r.rows){
      const days=dataValidityDays(t.metadata);
      if(!(days>=DATA_REMIND_MIN_DAYS))continue;
      const lead=days>=28?3:1;
      const bought=new Date(t.bought_at).getTime();
      const expiresAt=bought+days*DAY;
      if(now<expiresAt-lead*DAY||now>=expiresAt)continue;
      const newer=await db(`SELECT 1 FROM transactions WHERE user_id=$1 AND service='data' AND recipient=$2 AND id>$3 AND status IN ('successful','pending','processing') LIMIT 1`,[t.user_id,t.recipient,t.id]);
      if(newer.rows.length)continue;
      const plan=clean((t.metadata&&t.metadata.pricing&&t.metadata.pricing.plan)||(t.metadata&&t.metadata.request&&t.metadata.request.plan_name)||"data plan");
      const left=Math.max(1,Math.ceil((expiresAt-now)/DAY));
      await addNotificationOnce(t.user_id,"Data plan expiring soon",`${plan} for ${t.recipient} expires in about ${left} day${left===1?"":"s"}. Open Buy Data to renew it.`,"info",`data-expiry-${t.id}`);
    }
  }catch(e){console.error("DATA EXPIRY SWEEP ERROR:",e?.stack||e?.message||e);}
  finally{dataExpiryBusy=false;}
}

async function handleExtraUserRoutes(req,res,path,url){
const user=await userFromToken(req);
if(!user) return null;
if(path==="/api/autopay"||path.startsWith("/api/autopay/")){const apHandled=await handleAutopayRoutes(req,res,path,user);if(apHandled)return true;}
if(path==="/api/favorites"||path.startsWith("/api/favorites/")){const fvHandled=await handleFavoritesRoutes(req,res,path,user);if(fvHandled)return true;}
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
const elecDetails=String(t.service||"").toLowerCase().includes("electric")?electricityDetailsFromMetadata(meta):{};
return send(res,200,{success:true,transaction:{...t,...elecDetails,metadata:enrichedMeta,amount:Number(t.amount)}});
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
email:user.email,
accountType:(await getAgentProfile(user.user_id))?.status==='active'?'agent':'customer',
agent:await getAgentProfile(user.user_id)
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

/*
AGENT
*/
if(path==="/api/agent/status"||path==="/api/agent/activate"||path==="/api/agent/dashboard"||path==="/api/agent/transactions"||path==="/api/agent/transactions/export"||path==="/api/agent/customers"){
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
if(req.method==="GET"&&path==="/api/agent/status"){
  const agent=await getAgentProfile(user.user_id);
  const wallet=await getWallet(user.user_id);
  const limits=await getAgentLimits(agent);
  const services=await db(`SELECT s.key,s.name,s.icon,s.enabled AS platform_enabled,s.maintenance,COALESCE(a.enabled,TRUE) AS agent_enabled,a.markup_pct_override FROM services s LEFT JOIN agent_services a ON a.user_id=$1 AND a.service_key=s.key ORDER BY s.name`,[user.user_id]);
  const pricingRows=await getAllAgentPricing();
  const pricingByService=new Map(pricingRows.map(p=>[p.service,p]));
  let staticAccount=null;try{const sa=await getFlutterwaveStaticFundingAccount(user);staticAccount=sa.account||null;}catch{}
  return send(res,200,{success:true,isAgent:Boolean(agent&&agent.status==='active'),agent,minimumBalance:limits.minWalletBalance,currentBalance:Number(wallet?.balance||0),hasStaticAccount:Boolean(staticAccount),staticAccount:staticAccount?{accountNumber:staticAccount.account_number,bankName:staticAccount.bank_name,accountName:staticAccount.account_name}:null,services:services.rows.map(x=>{const globalRow=pricingByService.get(x.key);const pricing=agentPricingConfig(globalRow?{markup_percent:globalRow.markupPercent,fixed_fee:globalRow.fixedFee}:null,x.markup_pct_override!=null?Number(x.markup_pct_override):undefined);return {key:x.key,name:x.name,icon:x.icon,platform_enabled:Boolean(x.platform_enabled),maintenance:Boolean(x.maintenance),agent_enabled:Boolean(x.agent_enabled)&&Boolean(globalRow?globalRow.active:true),agent_markup_pct:pricing.markup_pct,agent_fixed_fee:pricing.markup_fixed};})});
}
if(req.method==="POST"&&path==="/api/agent/activate"){
  const rl=rateLimit(req,`agent-activate:${user.user_id}`,5,15*60*1000);if(!rl.allowed)return rateLimitedResponse(res,rl);
  try{const result=await activateAgentForUser(user,req);return send(res,result.success?200:(result.statusCode||400),result);}catch(e){console.error('AGENT ACTIVATION ERROR:',e?.stack||e?.message||e);return send(res,500,{success:false,message:'Unable to activate your Agent account right now.'});}
}
if(req.method==="GET"&&path==="/api/agent/dashboard"){
  const agent=await getAgentProfile(user.user_id);
  if(!agent||agent.status!=='active')return send(res,403,{success:false,message:'Your Agent account is not active.'});
  const wallet=await getWallet(user.user_id);
  // Only transactions that actually went through Agent pricing count here — a walk-in-style
  // purchase an Agent might still make for themselves (if that ever happens) isn't "Agent sales".
  const r=await db(`SELECT
    COUNT(*) FILTER(WHERE date::date=CURRENT_DATE)::int AS today_count,
    COALESCE(SUM(amount) FILTER(WHERE status='successful' AND date::date=CURRENT_DATE),0) AS today_sales,
    COALESCE(SUM(COALESCE((metadata->'pricing'->>'agentProfit')::numeric,0)) FILTER(WHERE status='successful' AND date::date=CURRENT_DATE),0) AS today_profit,
    COALESCE(SUM(amount) FILTER(WHERE status='successful'),0) AS total_sales,
    COALESCE(SUM(COALESCE((metadata->'pricing'->>'agentProfit')::numeric,0)) FILTER(WHERE status='successful'),0) AS total_profit,
    COUNT(*) FILTER(WHERE status IN ('pending','processing'))::int AS pending_count,
    COUNT(*) FILTER(WHERE status='failed')::int AS failed_count,
    COUNT(*) FILTER(WHERE status='successful')::int AS total_transactions
    FROM transactions WHERE user_id=$1 AND metadata->'pricing'->>'agentPrice' IS NOT NULL`,[user.user_id]);
  const s=r.rows[0]||{};
  return send(res,200,{success:true,agent,walletBalance:Number(wallet?.balance||0),today:{transactions:Number(s.today_count||0),sales:Number(s.today_sales||0),profit:Number(s.today_profit||0)},total:{sales:Number(s.total_sales||0),profit:Number(s.total_profit||0),transactions:Number(s.total_transactions||0)},pendingTransactions:Number(s.pending_count||0),failedTransactions:Number(s.failed_count||0)});
}
if(req.method==="GET"&&path==="/api/agent/transactions"){
  const agent=await getAgentProfile(user.user_id);
  if(!agent||agent.status!=='active')return send(res,403,{success:false,message:'Your Agent account is not active.'});
  const limit=Math.min(200,Math.max(1,Number(url.searchParams.get("limit"))||50));
  const r=await db(`SELECT reference,service,amount,status,recipient,provider_reference,date,metadata FROM transactions WHERE user_id=$1 AND metadata->'pricing'->>'agentPrice' IS NOT NULL ORDER BY date DESC LIMIT $2`,[user.user_id,limit]);
  return send(res,200,{success:true,transactions:r.rows.map(t=>{
    const p=t.metadata?.pricing||{};
    const req2=t.metadata?.request||{};
    const providerData=t.metadata?.provider_response||{};
    const delivery=providerData?.data?.delivery||providerData?.delivery||null;
    const pins=providerData?.data?.pins||providerData?.pins||delivery?.pins||[];
    const token=findTransactionField(providerData,["token","meter_token","recharge_token","standard_token","units_token","electricity_token","vend_token"])||delivery?.token||"";
    const units=findTransactionField(providerData,["units","kwh","unit"])||"";
    return{reference:t.reference,providerReference:t.provider_reference,service:t.service,status:t.status,recipient:t.recipient,date:t.date,agentPrice:Number(p.agentPrice||t.amount||0),customerSellingPrice:Number(p.customerSellingPrice||0),profit:Number(p.agentProfit||0),network:req2.network||null,phone:req2.phone||null,provider:req2.provider||null,plan:req2.plan||req2.plan_name||null,smartcard:req2.smartcard||null,meterNumber:req2.meterNumber||null,meterType:req2.meterType||null,examLabel:req2.examLabel||req2.product_code||null,quantity:req2.quantity||null,token,units,pins};
  })});
}
if(req.method==="GET"&&path==="/api/agent/transactions/export"){
  const agent=await getAgentProfile(user.user_id);
  if(!agent||agent.status!=='active')return send(res,403,{success:false,message:'Your Agent account is not active.'});
  const r=await db(`SELECT reference,service,amount,status,recipient,date,metadata FROM transactions WHERE user_id=$1 AND metadata->'pricing'->>'agentPrice' IS NOT NULL ORDER BY date DESC LIMIT 5000`,[user.user_id]);
  const escCsv=(v)=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  const header=['Date','Reference','Service','Recipient','Status','Your BOLTIV Price','Customer Price','Your Profit'];
  const lines=[header.join(',')];
  for(const t of r.rows){
    const p=t.metadata?.pricing||{};
    lines.push([new Date(t.date).toISOString(),t.reference,t.service,t.recipient||'',t.status,Number(p.agentPrice||t.amount||0).toFixed(2),Number(p.customerSellingPrice||0).toFixed(2),Number(p.agentProfit||0).toFixed(2)].map(escCsv).join(','));
  }
  const csv=lines.join('\n');
  if(FRONTEND_URL.startsWith("https://"))res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
  res.writeHead(200,{
    "Content-Type":"text/csv; charset=utf-8",
    "Content-Disposition":`attachment; filename="boltiv-agent-statement-${agent.agent_id}.csv"`,
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
  return res.end(csv);
}
if(path==="/api/agent/customers"){
  const agent=await getAgentProfile(user.user_id);
  if(!agent||agent.status!=='active')return send(res,403,{success:false,message:'Your Agent account is not active.'});
  if(req.method==="GET"){
    const r=await db(`SELECT id,name,phone,network,notes,created_at FROM agent_customers WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500`,[user.user_id]);
    return send(res,200,{success:true,customers:r.rows});
  }
  if(req.method==="POST"){
    const b=await body(req);
    const name=clean(b.name),phone=clean(b.phone),network=clean(b.network).toUpperCase(),notes=clean(b.notes);
    if(!name)return send(res,400,{success:false,message:'Customer name is required.'});
    if(!/^\d{11}$/.test(phone))return send(res,400,{success:false,message:'Enter a valid 11-digit phone number.'});
    const r=await db(`INSERT INTO agent_customers(user_id,name,phone,network,notes) VALUES($1,$2,$3,$4,$5) RETURNING id,name,phone,network,notes,created_at`,[user.user_id,name,phone,network||null,notes||null]);
    return send(res,200,{success:true,customer:r.rows[0]});
  }
  if(req.method==="DELETE"){
    const b=await body(req);
    const id=Number(b.id);
    if(!Number.isFinite(id))return send(res,400,{success:false,message:'Customer ID is required.'});
    await db(`DELETE FROM agent_customers WHERE id=$1 AND user_id=$2`,[id,user.user_id]);
    return send(res,200,{success:true});
  }
}
}


if(
req.method==="GET"&&
path==="/api/referral"
){
const user=await userFromToken(req);
if(!user){return send(res,401,{success:false,message:"Unauthorized."});}
try{
const referral=await referralSummaryForUser(user.user_id);
return send(res,200,{success:true,referral});
}catch(error){
console.error("REFERRAL SUMMARY ERROR:",error?.stack||error?.message||error);
return send(res,200,{success:false,message:"Referral information is unavailable right now."});
}
}

if(
req.method==="GET"&&
path==="/api/bonus"
){
const user=await userFromToken(req);
if(!user){return send(res,401,{success:false,message:"Unauthorized."});}
try{
const summary=await bonusSummaryForUser(user.user_id);
return send(res,200,{success:true,bonus:summary});
}catch(error){
console.error("BONUS SUMMARY ERROR:",error?.stack||error?.message||error);
return send(res,200,{success:true,bonus:{enabled:false,balance:0,nextExpiry:null,totalEarned:0,expiryDays:BONUS_EXPIRY_DAYS,maxCashback:BONUS_MAX_CASHBACK}});
}
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
let rawBody="";
try{
rawBody=await new Promise((resolve,reject)=>{
let data="";
req.on("data",chunk=>{
data+=chunk;
if(data.length>1024*1024){
req.destroy();
reject(new Error("Request body too large."));
}
});
req.on("end",()=>resolve(data));
req.on("error",reject);
});

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
const result=await creditFlutterwaveVirtualAccount(payload);
return send(res,200,{success:true,message:result.duplicate?"Webhook already processed.":"Flutterwave funding webhook processed.",...result});
}
return send(res,200,{success:true,message:"Flutterwave webhook received."});
}catch(error){
console.error("FLUTTERWAVE WEBHOOK ERROR:",error);
return send(res,500,{success:false,message:error.message||"Webhook processing failed."});
}
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
const agentService=await getEffectiveAgentService(user.user_id,"data");
const dataPricingRow=agentService.isAgent?await getAgentPricingRow("data"):null;
const agentPricing=(agentService.isAgent&&dataPricingRow&&dataPricingRow.active!==false)?agentPricingConfig(dataPricingRow,agentService.markupOverride):null;
const byPlan=new Map();
for(const plan of rawPlans){
const planCode=clean(plan.plan_code||plan.code||""), providerPrice=Number(plan.price||0), planServiceId=Number(plan.service_id||0);
if(!planCode||!Number.isFinite(providerPrice)||providerPrice<=0)continue;
const customerPrice=customerPriceFromCost(providerPrice,pricing);
if(customerPrice===null)continue;
const agentPrice=agentPricing?customerPriceFromCost(providerPrice,agentPricing):null;
const lookupKey=planLookupKey(planCode,planServiceId);
byPlan.set(lookupKey,{code:planCode,plan_code:planCode,provider_code:planCode,lookup_key:lookupKey,bundle_id:lookupKey,name:clean(plan.name||planCode),customer_price:customerPrice,agent_price:agentPrice,provider_price:Number(providerPrice.toFixed(2)),network_name:network,sales_channel:clean(plan.sales_channel||''),service_id:planServiceId,size_mb:Number(plan.size_mb||0),validity_days:Number(plan.validity_days||0),validity:clean(plan.validity||plan.validity_period||plan.duration||"") ,validity_period:clean(plan.validity_period||plan.validity||plan.duration||"") ,duration:clean(plan.duration||plan.validity||plan.validity_period||"")});
}
const plans=Array.from(byPlan.values())
.filter(plan=>Number(plan.size_mb||0)>=MIN_DATA_PLAN_MB)
.sort((a,b)=>Number(a.customer_price)-Number(b.customer_price)).slice(0,500);
return send(res,200,{success:true,network,plans,isAgent:agentService.isAgent,agentEnabled:agentService.enabled});
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

if(req.method==="POST"&&path==="/api/vtu/cable/verify"){const user=await userFromToken(req);if(!user)return send(res,401,{success:false,message:"Unauthorized."});const r=await verifyVTUGATECable(req,user);return send(res,r.success?200:(r.statusCode||400),r);}
if(req.method==="POST"&&path==="/api/vtu/electricity/verify"){const user=await userFromToken(req);if(!user)return send(res,401,{success:false,message:"Unauthorized."});const r=await verifyVTUGATEElectricity(req);return send(res,r.success?200:(r.statusCode||400),r);}

/*
SMS
*/
if(path.startsWith("/api/sms/")){
const rl=rateLimit(req,"sms",path.endsWith("/send")?10:40,60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
let result=null;
if(req.method==="GET"&&path==="/api/sms/config")result=await smsConfig(user);
else if(req.method==="POST"){
const b=await body(req);
if(path==="/api/sms/quote")result=await smsQuote(user,b);
else if(path==="/api/sms/send")result=await processSendSms(user,b);
else if(path==="/api/sms/sender-ids")result=await smsRequestSenderId(user,b);
}
if(result)return send(res,result.success?200:(result.statusCode||400),result);
}
if(path.startsWith("/api/admin/sms/sender-ids")){
const b=req.method==="POST"?await body(req):{};
const result=await adminSmsSenderIds(req,path,b);
return send(res,result.success?200:(result.statusCode||400),result);
}

/*
INTERNATIONAL TOP-UP
*/
if(path.startsWith("/api/vtu/international/")){
const rl=rateLimit(req,"vtu-international",path.endsWith("/topup")?10:40,60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
if(req.method==="GET"&&path==="/api/vtu/international/countries"){
const s=await intlService(user.user_id);if(s.error)return send(res,s.error.statusCode,s.error);
try{return send(res,200,{success:true,countries:await getIntlCountries()});}catch(e){console.error("INTL COUNTRIES ERROR:",e.message);return send(res,502,{success:false,message:"Unable to load countries right now."});}
}
if(req.method==="POST"){
const b=await body(req);let result=null;
if(path==="/api/vtu/international/operators"){
const s=await intlService(user.user_id);if(s.error)return send(res,s.error.statusCode,s.error);
const v=intlValidateCommon(b);if(v.error)return send(res,400,v.error);
try{result={success:true,operators:await getIntlOperators(v.countryCode,clean(b.type)==="data"?"data":"")};}catch(e){console.error("INTL OPERATORS ERROR:",e.message);result={success:false,statusCode:502,message:"Unable to load operators right now."};}
}
else if(path==="/api/vtu/international/detect")result=await intlDetect(user,b);
else if(path==="/api/vtu/international/quote")result=await intlQuoteRoute(user,b);
else if(path==="/api/vtu/international/topup")result=await processInternationalTopup(user,b);
if(result)return send(res,result.success?200:(result.statusCode||400),result);
}
}

/*
BULK AIRTIME
*/
if(req.method==="POST"&&path==="/api/vtu/airtime/bulk"){
const rl=rateLimit(req,"vtu-bulk-airtime",5,60*1000);
if(!rl.allowed)return rateLimitedResponse(res,rl);
const user=await userFromToken(req);
if(!user)return send(res,401,{success:false,message:"Unauthorized."});
const b=await body(req);
const result=await processBulkAirtime(user,b);
return send(res,result.success?200:(result.statusCode||400),result);
}

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
"Access-Control-Allow-Credentials":"true",
"Access-Control-Max-Age":"86400"
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
  const keys=['airtime','data','cable','electricity','exam_pin','international','sms'];
  const out={};
  for(const key of keys){const svc=await getService(key);const p=pricingConfig(svc);out[key]={available:Boolean(svc&&svc.enabled!==false&&svc.maintenance!==true)};if(key==='electricity')Object.assign(out[key],{markupPct:Number(p.markup_pct||0),serviceFee:Number(p.service_fee||0),minAmount:MIN_ELECTRICITY_AMOUNT});}
  return send(res,200,{success:true,pricing:out});
}

if(req.method==='GET'&&path==='/api/services'){const r=await db(`SELECT key,name,icon,enabled,maintenance FROM services WHERE key IN ('airtime','data','electricity','cable','exam_pin','international','sms') ORDER BY key`);return send(res,200,{success:true,services:r.rows.map(x=>({...x,available:x.enabled!==false&&x.maintenance!==true}))});}
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
// Bonus expiry sweep: shortly after boot, then every 30 minutes.
setTimeout(()=>expireBonusLots().catch(e=>console.error("BONUS EXPIRY ERROR",e)),20000).unref();
setInterval(()=>expireBonusLots().catch(e=>console.error("BONUS EXPIRY ERROR",e)),30*60*1000).unref();

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
setTimeout(()=>verifyRecentSuccessfulTransactions(),90000).unref();
setInterval(()=>verifyRecentSuccessfulTransactions(),15*60*1000).unref();

// AutoPay: check for due runs and day-before reminders every minute.
setTimeout(()=>autopayTick().catch(e=>console.error("AUTOPAY INITIAL TICK ERROR:",e)),25000).unref();
setInterval(()=>smsSyncSenderIds(true).catch(e=>console.error("SMS SENDER SYNC ERROR",e?.message)),30*60*1000).unref();
setInterval(()=>autopayTick().catch(e=>console.error("AUTOPAY TICK ERROR:",e)),60*1000).unref();

// Data expiry reminders: check every 30 minutes.
setTimeout(()=>dataExpirySweep(),45000).unref();
setInterval(()=>dataExpirySweep(),30*60*1000).unref();

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

