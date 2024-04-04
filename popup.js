const tabs =await chrome.tabs.query({});
const tabsSelectDom =  document.getElementById("tabs");
const serverDom = document.getElementById("server")
for (const tab of tabs) {
    let option = document.createElement("option");
    option.text = tab.title;
    option.value = tab.id;
    tabsSelectDom.add(option);
}
const localServer = localStorage.getItem("server");
if(localServer){
    serverDom.value = localServer;
}
serverDom.addEventListener('change',  (e)=> {
    const serverDom = document.getElementById("server")
    const server = serverDom.value;
    localStorage.setItem("server",server);
});

tabsSelectDom.addEventListener('change',  (e)=> {
    const serverDom = document.getElementById("server")
    const server = serverDom.value;
    (async ()=>{
        const response = await chrome.runtime.sendMessage({id:e.target.value,server:server});
    })();

});

