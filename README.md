<p align="center">
  <img src="./images/icon-128.png">
  <h1 align="center">Request Pipeline</h1>
</p>
This is a chrome extension that forwards the content of network requests on web pages to the processing server.This extension can better help development engineers or test engineers understand the specifics of interface requests and responses in web pages.

## Under the hood

The main reason this tool uses the chrome extension as a development platform is that you don't have to use a development tool to simulate the entire workflow of the site (for example, you need to log in when getting some data). With this plugin you just need to visit the page you want to get the web request in the explorer normally, then open this plugin and you can get the data you need.

The chrome extension does not have an API that can directly obtain all requests from web pages, but there are usually two ways to achieve this function.

1. By extending the ability to inject javascript into the webpage, this implementation method is to inject javascript code into the header of the target webpage, and the main content of the javascript code is to hijack the xhr request of the webpage. But there is also a problem. When the request is generated before the dom node of the web page, this method cannot be captured.
2. Another method is based on `chrome.devtools.network` API, which is more convenient, but the only problem is that you need to keep devtools open during the capture request. Because this API can only be called in the devtools toolbar.

What I am currently implementing is based on the debugger API, which is actually used for remote debugging of applications that support Chrome DevTools Protocol. Chrome itself supports this protocol.

The debugger API mainly requires two steps, Attaches debugger to the given target and Detaches debugger from the given target.

After attaching the debugger to a given target, we can use `sendCommand` method to issue instructions to the debugger.For specific commands that can be used, refer to [here](https://chromedevtools.github.io/devtools-protocol/).

This extension mainly focuses on the [debugger's Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)。

First we need to enable network tracking, the `Network.enable` command.

Then we need to catch the debugger event, through `chrome.debugger.onEvent`.

Finally filter the event content I need.

### About Debugger Network Event

A network request is split into many events in the debugger. Take the HTTP network request as an example:

- `Network.dataReceived` is fired when data chunk was received over the network.
- `Network.eventSourceMessageReceived` is fired when EventSource message is received.
- `Network.loadingFailed` is fired when HTTP request has failed to load.
- `Network.loadingFinished` is fired when HTTP request has finished loading.
- `Network.requestServedFromCache` is fired if request ended up loading from cache.
- `Network.requestWillBeSent` is fired when page is about to send HTTP request.
- `Network.responseReceived` is fired when HTTP response is available.
- and more

The three main events I use in this extension are `Network.requestWillBeSent`, `Network.responseReceived`, and `Network.loadingFinished`.

`Network.requestWillBeSent` in this event I get the request submit data.

`Network.responseReceived` in this event I get response data and cookies.

`Network.loadingFinished` In this event, I get the response body data through the `Network.getResponseBody` method, because this is the last of all events.

At this point, all the necessary data are obtained.

### One more thing

In this extension I have filtered out css and js content and only allow requests starting with http. In fact, you can also capture WebSocket content according to the Debugger documentation, and you are welcome to contribute to the functionality!

## Install

- [chrome web store](https://chrome.google.com/webstore/detail/request-pipeline/kkaplobblnfnadlodpgdehhieofppead)
- If you want to use it right away, you can clone this repository, then click the Load unzipped extensions button in the chrome extension manager and select the plugin directory in the window that opens to use it.

## Use

![use](./asset/image/use.jpg)



1. Clicking on the extension will bring up the popup page for this extension. If you don't see this extension in the extension bar, you need to click on the extension icon (like a puzzle icon) and then find this extension and click on it.
   It is highly recommended that you fix this extension in the extension bar to make it easier to use later (just click on the extension icon and find it in the list and click on the pin button next to it).
2. This extension has only two actionable options. ***Server Address*** means which processor you want to send the captured request data to. ***Select Tabs*** means the tab you want to capture the request. When you select the corresponding tab, chrome will pop up a "Request Pipeline started debugging this browser" reminder, **in Do not press Cancel during the capture request**.
3. When you want to stop capturing requests, click the Cancel button on the banner.

### Data format

The request sent by the extension is **POST**, and the data format is **JSON**. The specific format is as follows:

| FIELD         | TYPE                                                         | NOTE                                                         |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **cookies**   | **array**[ [Cookie](https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-Cookie) ] | https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getCookies |
|  **request**       | [Request](https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-Request) | https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-requestWillBeSent |
|  **response**      | [Response](https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-Response) | https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-responseReceived |
| **response_body** | **map**                                                          | https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getResponseBody |



## reference

https://developer.chrome.com/docs/extensions/reference/#stable_apis

https://chromedevtools.github.io/devtools-protocol/tot/Network/



## Thanks

[Pipeline icons created by Becris - Flaticon](https://www.flaticon.com/free-icons/pipeline)

[Chrome Extension: "No resource with given identifier found" when trying to Network.getResponseBody](https://stackoverflow.com/questions/47962104/chrome-extension-no-resource-with-given-identifier-found-when-trying-to-netwo)

[Chrome Extension - How to get HTTP Response Body?](https://stackoverflow.com/questions/18534771/chrome-extension-how-to-get-http-response-body)
