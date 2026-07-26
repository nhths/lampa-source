import Template from './template'
import Modal from './modal'
import Controller from '../core/controller'
import Lang from '../core/lang'
import Storage from '../core/storage/storage'
import Noty from './noty'
import DeviceCaps from '../core/device_caps'

// Read logs from both ring buffers exposed by device_caps.js and
// torserver.js. Each module owns its own buffer; this file is the
// viewer.
function readCapsLog(){
    try{ return (typeof window !== 'undefined' && window.__LAMPA_CAPS_LOG__) ? window.__LAMPA_CAPS_LOG__() : [] }
    catch(e){ return [] }
}

function readTsLog(){
    try{ return (typeof window !== 'undefined' && window.__LAMPA_TS_LOG__) ? window.__LAMPA_TS_LOG__() : [] }
    catch(e){ return [] }
}

// Clear by swapping the global getter to return an empty array. The
// underlying ring arrays stay intact in their modules but the viewer
// reads through these getters, so this is enough to give the user
// visual feedback that the clear worked.
function clearLogs(){
    try{ window.__LAMPA_CAPS_LOG__ = ()=>[] }catch(e){}
    try{ window.__LAMPA_TS_LOG__ = ()=>[] }catch(e){}
}

function enableLogs(){
    try{ Storage.set('lampa_caps_debug', '1') }catch(e){}
    try{ Storage.set('lampa_ts_debug', '1') }catch(e){}
    if(typeof window !== 'undefined'){
        window.__LAMPA_CAPS_DEBUG__ = true
        window.__LAMPA_TS_DEBUG__ = true
    }
    // Kick off a no-op probe so the buffer has at least one entry
    // when the user opens the modal.
    try{ DeviceCaps.gstQuery({streams: []}) }catch(e){}
}

function disableLogs(){
    try{ Storage.set('lampa_caps_debug', '') }catch(e){}
    try{ Storage.set('lampa_ts_debug', '') }catch(e){}
    if(typeof window !== 'undefined'){
        window.__LAMPA_CAPS_DEBUG__ = false
        window.__LAMPA_TS_DEBUG__ = false
    }
}

function isEnabled(){
    let a = false, b = false
    try{ a = !!Storage.get('lampa_caps_debug') }catch(e){}
    try{ b = !!Storage.get('lampa_ts_debug') }catch(e){}
    return a || b
}

function escapeHtml(s){
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function renderEntry(entry){
    let ts = entry.ts || '?'
    let kind = entry.kind || 'event'
    let payload = Object.assign({}, entry)
    delete payload.ts
    delete payload.kind

    let payloadStr = ''
    try{ payloadStr = JSON.stringify(payload, null, 2) }catch(e){ payloadStr = String(payload) }

    return `<div class="lampa-log__entry">
        <div class="lampa-log__entry-head">
            <span class="lampa-log__entry-ts">${escapeHtml(ts)}</span>
            <span class="lampa-log__entry-kind">${escapeHtml(kind)}</span>
        </div>
        <pre class="lampa-log__entry-body">${escapeHtml(payloadStr)}</pre>
    </div>`
}

let modalBody = null

function buildBody(){
    let caps = readCapsLog()
    let ts = readTsLog()

    if(caps.length === 0 && ts.length === 0){
        return `<div class="lampa-log__empty">${escapeHtml(Lang.translate('settings_server_logs_empty'))}</div>`
    }

    let html = ''

    if(caps.length){
        html += `<div class="lampa-log__section">
            <div class="lampa-log__caption">${escapeHtml(Lang.translate('settings_server_logs_caption_caps'))} (${caps.length})</div>`
        caps.forEach((e)=>{ html += renderEntry(e) })
        html += '</div>'
    }

    if(ts.length){
        html += `<div class="lampa-log__section">
            <div class="lampa-log__caption">${escapeHtml(Lang.translate('settings_server_logs_caption_lifecycle'))} (${ts.length})</div>`
        ts.forEach((e)=>{ html += renderEntry(e) })
        html += '</div>'
    }

    return html
}

function refresh(){
    if(!modalBody) return
    modalBody.html(buildBody())
}

function copyJson(){
    let data = {
        ts: new Date().toISOString(),
        caps: readCapsLog(),
        lifecycle: readTsLog(),
    }
    let payload = ''
    try{ payload = JSON.stringify(data, null, 2) }catch(e){ payload = String(data) }
    if(typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(payload)
    } else {
        // Fallback for older WebViews (Tizen 2018, WebOS 4, etc.):
        // hidden textarea + execCommand.
        let ta = document.createElement('textarea')
        ta.value = payload
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try{ document.execCommand('copy') }catch(e){}
        document.body.removeChild(ta)
    }
    try{
        Noty.show(Lang.translate('settings_server_logs_copied'), {time: 2000})
    }catch(e){}
}

function open(){
    if(!isEnabled()){
        enableLogs()
    }

    // Template 'lampa_logs' is registered by services/torrserver.js
    // (it lives there so the registry stays close to the wiring).
    let temp = Template.get('lampa_logs', {})
    modalBody = temp.find('.lampa-log__body')
    let refreshBtn = temp.find('.lampa-log__refresh')
    let clearBtn = temp.find('.lampa-log__clear')
    let copyBtn = temp.find('.lampa-log__copy')
    let backBtn = temp.find('.lampa-log__back')

    refresh()

    refreshBtn.on('hover:enter', refresh)
    clearBtn.on('hover:enter', ()=>{
        clearLogs()
        refresh()
    })
    copyBtn.on('hover:enter', copyJson)
    backBtn.on('hover:enter', ()=>{
        Modal.close()
    })

    Modal.title(Lang.translate('settings_server_logs_modal_title'))
    Modal.update(temp)

    Controller.add('modal', {
        invisible: true,
        toggle: ()=>{
            Controller.collectionSet(temp)
            Controller.collectionFocus(refreshBtn, temp)
        },
        back: ()=>{
            Modal.close()
        },
    })

    Controller.toggle('modal')
}

// Bound by settings toggle handler when the user changes the value.
function onEnabledChange(){
    if(isEnabled()) enableLogs()
    else disableLogs()
}

function show(){
    open()
}

export default {
    show,
    enableLogs,
    disableLogs,
    isEnabled,
    refresh,
}