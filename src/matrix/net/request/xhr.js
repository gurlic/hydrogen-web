/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {
    AbortError,
    ConnectionError
} from "../../error.js";
import {addCacheBuster} from "../common.js";

class RequestResult {
    constructor(promise, xhr) {
        this._promise = promise;
        this._xhr = xhr;
    }

    abort() {
        this._xhr.abort();
    }

    response() {
        return this._promise;
    }
}

function send(url, options) {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method, url);
    if (options.headers) {
        for(const [name, value] of options.headers.entries()) {
            xhr.setRequestHeader(name, value);
        }
    }
    if (options.timeout) {
        xhr.timeout = options.timeout;
    }

    xhr.send(options.body || null);

    return xhr;
}

function xhrAsPromise(xhr, method, url) {
    return new Promise((resolve, reject) => {
        xhr.addEventListener("load", () => resolve(xhr));
        xhr.addEventListener("abort", () => reject(new AbortError()));
        xhr.addEventListener("error", () => reject(new ConnectionError(`Error ${method} ${url}`)));
        xhr.addEventListener("timeout", () => reject(new ConnectionError(`Timeout ${method} ${url}`, true)));
    });
}

export function xhrRequest(url, options) {
    url = addCacheBuster(url);
    const xhr = send(url, options);
    const promise = xhrAsPromise(xhr, options.method, url).then(xhr => {
        const {status} = xhr;
        let body = xhr.responseText;
        if (xhr.getResponseHeader("Content-Type") === "application/json") {
            body = JSON.parse(body);
        }
        return {status, body};
    });
    return new RequestResult(promise, xhr);
}
