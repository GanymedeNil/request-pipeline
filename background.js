let currentTabId;
let version = "1.0";
let server = '';
const requests = new Map();

chrome.runtime.onMessage.addListener((request,sender,sendResponse)=>{
    if(currentTabId){
        chrome.debugger.detach({tabId:currentTabId})
    }
    currentTabId = parseInt(request.id);
    if(currentTabId<0) {
        return;
    }
    server = request.server;
    chrome.debugger.attach({
            tabId: currentTabId
        }, version, onAttach.bind(null, currentTabId));
    chrome.debugger.onDetach.addListener(debuggerDetachHandler)
    console.log("attach")
    sendResponse({status:0});
})
function debuggerDetachHandler(){
    console.log("detach")
    requests.clear()
}
function onAttach(tabId) {

    chrome.debugger.sendCommand({ //first enable the Network
        tabId: tabId
    }, "Network.enable");

    chrome.debugger.onEvent.addListener(allEventHandler);

}
// https://chromedevtools.github.io/devtools-protocol/tot/Network
function allEventHandler(debuggeeId, message, params) {
    if (currentTabId != debuggeeId.tabId) {
        return;
    }
        // get request data
    if(message == "Network.requestWillBeSent") {
        if(params.request && filter(params.request.url)) {
            const detail = new Map();
            detail.set('request',params.request)
            requests.set(params.requestId,detail)
        }
    }

    // get response data
    if (message == "Network.responseReceived") {
        if(params.response && filter(params.response.url)){
            const request =  requests.get(params.requestId);
            if( request===undefined ){
                console.log(params.requestId,"#not found request")
                  return;
              }
            request.set("response",params.response)
            chrome.debugger.sendCommand({
              tabId: debuggeeId.tabId
          }, "Network.getCookies", {
              "urls": [params.response.url]
          }, function(response) {
                request.set("cookies",response.cookies)
            });
            requests.set(params.requestId,request)

      }
    }

    if(message == "Network.loadingFinished") {
        const request =  requests.get(params.requestId);
        if( request===undefined ){
            console.log(params.requestId,"#not found request")
            return;
        }

        chrome.debugger.sendCommand({
            tabId: debuggeeId.tabId
        }, "Network.getResponseBody", {
            "requestId": params.requestId
        }, function(response) {
            if(response){
                request.set("response_body",response)
                requests.set(params.requestId,request)
                console.log(request)
                sendData(request)
                requests.delete(params.requestId)
            }else{
                console.log("empty")
            }
        });
    }
}
function sendData(data) {
    if(server.length===0){
        return
    }
    fetch(server,{
        method:'post',
        body:JSON.stringify(Object.fromEntries(data))
    })
}

function filter(url){
    return url.startsWith("http") && !url.endsWith('css') && !url.endsWith('js')
}
