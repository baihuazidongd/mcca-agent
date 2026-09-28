"use strict";
const { randomUUID } = require("node:crypto");
const BODY_LIMIT = 256 * 1024, TOTAL_LIMIT = 8 * 1024 * 1024;
function createNetworkRecorder() {
  const rows = new Map(), pending = new Set(); let bytes = 0, epoch = 0;
  function record(request, page) {
    const generation = epoch, id = randomUUID();
    if (pending.size >= 16) return;
    const op = (async () => {
      const response = await request.response().catch(() => null), timing = request.timing();
      const requestHeaders = await request.allHeaders(), responseHeaders = response ? await response.allHeaders() : {};
      const sizes = await request.sizes().catch(() => ({})), post = request.postDataBuffer();
      let body = null, bodyNote = response ? "Response exceeds retention limit or size is unknown" : "No response";
      if (response && Number.isFinite(sizes.responseBodySize) && sizes.responseBodySize <= BODY_LIMIT && bytes < TOTAL_LIMIT) {
        try { body = await response.body(); bodyNote = body.length > BODY_LIMIT ? "Response truncated to 256 KB" : ""; } catch (error) { bodyNote = error.message; }
      }
      if (generation !== epoch) return;
      const retain = value => { const kept = value?.subarray(0, Math.max(0,Math.min(BODY_LIMIT,TOTAL_LIMIT-bytes))); bytes += kept?.length || 0; return kept || Buffer.alloc(0); };
      const requestBody = retain(post), responseBody = retain(body);
      const row = { id, at: timing.startTime || Date.now(), page, method:request.method(), url:request.url(), type:request.resourceType(), timing, requestHeaders, responseHeaders, requestBody:requestBody.toString("base64"), responseBody:responseBody.toString("base64"), encoding:"base64", status:response?.status() || 0, statusText:response?.statusText() || "", requestBytes:post?.length || 0, responseBytes:body?.length ?? sizes.responseBodySize ?? -1, retainedBytes:requestBody.length+responseBody.length, requestBodyTruncated:requestBody.length<(post?.length||0), responseBodyTruncated:!body || responseBody.length<body.length, bodyNote, error:request.failure()?.errorText };
      rows.set(id,row);
      while(rows.size>300) {const first=rows.values().next().value;bytes-=first.retainedBytes;rows.delete(first.id);}
    })().catch(() => {}).finally(() => pending.delete(op));
    pending.add(op);
  }
  async function settle() { await Promise.allSettled([...pending]); }
  function list() { return [...rows.values()].map(({requestBody,responseBody,requestHeaders,responseHeaders,...r})=>r); }
  function detail(id) {const row=rows.get(id);if(!row)throw new Error("请求已过期，请重新查询网络记录");return {...row};}
  function har() {
    const headers=obj=>Object.entries(obj).map(([name,value])=>({name,value}));
    return {log:{version:"1.2",creator:{name:"mcca",version:"0.1.0"},entries:[...rows.values()].map(r=>({
      startedDateTime:new Date(r.at).toISOString(),time:Math.max(0,r.timing.responseEnd),
      request:{method:r.method,url:r.url,httpVersion:"HTTP/1.1",headers:headers(r.requestHeaders),queryString:[...new URL(r.url).searchParams].map(([name,value])=>({name,value})),cookies:[],headersSize:-1,bodySize:r.requestBytes,...(r.requestBytes?{postData:{mimeType:r.requestHeaders["content-type"]||"",text:Buffer.from(r.requestBody,"base64").toString("utf8"),comment:r.requestBodyTruncated?"Truncated":""}}:{})},
      response:{status:r.status,statusText:r.statusText,httpVersion:"HTTP/1.1",headers:headers(r.responseHeaders),cookies:[],content:{size:r.responseBytes,mimeType:r.responseHeaders["content-type"]||"",text:r.responseBody,encoding:"base64",comment:r.bodyNote||(r.responseBodyTruncated?"Retention budget exceeded":"")},redirectURL:r.responseHeaders.location||"",headersSize:-1,bodySize:r.responseBytes},cache:{},
      timings:{send:0,wait:Math.max(0,r.timing.responseStart),receive:Math.max(0,r.timing.responseEnd-r.timing.responseStart)},...(r.error?{_error:r.error}:{})
    }))}};
  }
  return {record,settle,list,detail,har,clear(){epoch++;rows.clear();bytes=0;},limits:{flows:300,bodyBytes:BODY_LIMIT,totalBodyBytes:TOTAL_LIMIT}};
}
module.exports={createNetworkRecorder};
