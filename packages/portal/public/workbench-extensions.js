"use strict";
const extensionPanel = node("section"); extensionPanel.id = "extension-editor"; extensionPanel.className = "panel"; extensionPanel.hidden = true;
extensionPanel.innerHTML = '<h2>共享扩展与定制</h2><p>管理 pi/dsh 共享插件、技能、MCP 和 dsh patch。保存前检查语法并备份；已有任务继续运行，新会话加载更新。</p><div class="form-grid"><label>类型<select id="extension-kind"><option value="plugin">插件</option><option value="skill">技能</option><option value="config">配置</option></select></label><button id="extension-scan">刷新文件</button><label>已有文件<select id="extension-files"></select></label><button id="extension-open">读取文件</button></div><form id="extension-edit"><label>相对路径<input id="extension-file" required placeholder="my-plugin/index.mjs"></label><label>内容<textarea id="extension-text" rows="16" spellcheck="false"></textarea></label><button type="button" id="extension-read-path">读取路径 / 准备新文件</button><button type="submit" id="extension-save" disabled>验证并保存</button><button type="button" id="extension-history">文件修订记录</button></form><div id="extension-revisions" class="cards"></div><h3>安装或更新扩展目录</h3><form id="bundle-form" class="form-grid"><label>类型<select name="kind"><option value="plugin">插件</option><option value="skill">技能</option></select></label><label>安装名称<input name="name" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}" required></label><label class="wide">本机扩展目录<input name="source" placeholder="下载并解压后的目录绝对路径" required></label><button type="submit">验证并预览安装</button><button type="button" id="bundle-install" disabled>安装 / 更新已预览内容</button><button type="button" id="bundle-history">扩展安装历史</button></form><div id="bundle-revisions" class="cards"></div>';
$("main").insertBefore(extensionPanel,$("#result-panel"));
const extensionTab = node("button","扩展与定制"); $("nav").append(extensionTab);
extensionTab.onclick = () => { document.querySelectorAll(".panel").forEach(p => {p.hidden=p!==extensionPanel;}); document.querySelectorAll("nav button").forEach(b => b.classList.toggle("selected",b===extensionTab)); };
let openedExtension, preparedBundle;
function invalidateFile() { openedExtension = null; $("#extension-save").disabled = true; }
$("#extension-kind").onchange = () => { invalidateFile(); $("#extension-files").replaceChildren(); };
$("#extension-file").oninput = invalidateFile;
async function readExtension(file) {
  const row = await call("app_extension_files",{action:"read",kind:$("#extension-kind").value,file});
  openedExtension = row; $("#extension-file").value=file; $("#extension-text").value=row.text; $("#extension-save").disabled=false; return {file,exists:row.exists,sha256:row.sha256};
}
$("#extension-scan").onclick = event => act(async()=>{const rows=await call("app_extension_files",{action:"list",kind:$("#extension-kind").value});options($("#extension-files"),rows,r=>r.file,r=>r.file);return rows;},event.target);
$("#extension-open").onclick = event => act(()=>readExtension($("#extension-files").value),event.target);
$("#extension-read-path").onclick = event => act(()=>readExtension($("#extension-file").value),event.target);
$("#extension-edit").onsubmit = event => {event.preventDefault(); act(async()=>{if(!openedExtension)throw new Error("请先读取文件");const value=await call("app_extension_files",{action:"write",kind:openedExtension.kind,file:openedExtension.file,text:$("#extension-text").value,expectedSha256:openedExtension.sha256||""});openedExtension=value;return {revision:value.revision,sha256:value.sha256,note:value.note,reload:value.reload};},event.submitter);};
$("#extension-history").onclick = event => act(async()=>{
  const rows=await call("app_extension_files",{action:"history",kind:$("#extension-kind").value,file:$("#extension-file").value}); $("#extension-revisions").replaceChildren();
  for(const row of rows){const card=node("article");card.className="card";card.append(node("p",new Date(row.at).toLocaleString()+" · "+row.file),button("回滚此修改",async()=>{if(!openedExtension||openedExtension.file!==row.file||openedExtension.kind!==row.kind)throw new Error("请先读取当前文件后再回滚");const value=await call("app_extension_files",{action:"rollback",revision:row.revision,expectedSha256:openedExtension.sha256||""});await readExtension(row.file);return {revision:value.revision,reload:value.reload};}));$("#extension-revisions").append(card);}return rows;
},event.target);
$("#bundle-form").oninput = ()=>{preparedBundle=null;$("#bundle-install").disabled=true;};
$("#bundle-form").onsubmit = event=>{event.preventDefault();act(async()=>{preparedBundle=await call("app_extension_packages",{action:"inspect_bundle",...Object.fromEntries(new FormData(event.currentTarget))});$("#bundle-install").disabled=false;return preparedBundle;},event.submitter);};
$("#bundle-install").onclick = event=>act(async()=>{if(!preparedBundle)throw new Error("请先预览");const {kind,name,source,sourceSha256,currentSha256}=preparedBundle;const value=await call("app_extension_packages",{action:"import_bundle",kind,name,source,sourceSha256,expectedSha256:currentSha256||""});preparedBundle=null;return value;},event.target);
$("#bundle-history").onclick = event=>act(async()=>{
  const rows=await call("app_extension_packages",{action:"bundle_history"});$("#bundle-revisions").replaceChildren();
  for(const row of rows){const card=node("article");card.className="card";card.append(node("p",row.name+" · "+new Date(row.at).toLocaleString()),button("回滚安装 / 更新",()=>call("app_extension_packages",{action:"rollback_bundle",revision:row.revision,expectedSha256:row.afterSha256||""})));$("#bundle-revisions").append(card);}return rows;
},event.target);
