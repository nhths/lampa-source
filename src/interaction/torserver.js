import Storage from '../core/storage/storage'
import Utils from '../utils/utils'
import Request from '../utils/reguest'
import Template from './template'
import Controller from '../core/controller'
import Modal from './modal'
import Lang from '../core/lang'
import Noty from './noty'
import EpisodeParser from '../utils/episodes_parser'
import Arrays from '../utils/arrays'
import DeviceCaps from '../core/device_caps'

let network  = new Request()
let gst_work = false

function url(){
    let u = ip()

    return u ? Utils.checkEmptyUrl(u) : u
}

function ip(){
    let one = Storage.get('torrserver_url')
    let two = Storage.get('torrserver_url_two')

    return Storage.field('torrserver_use_link') == 'two' ? two || one : one || two
}

// TorrentError: structured failure passed to UI instead of a bare
// string. The shape lets error() show a category title, human text,
// and the raw context (URL + HTTP status) so the user knows what to
// check or what to paste when filing a bug report.
const ErrorKind = {
    Network:      'network',      // no connection, DNS, CORS, abort, generic
    Timeout:      'timeout',
    Auth:         'auth',         // 401/403
    NotFound:     'not_found',    // 404 / bad hash
    Server:       'server',       // 5xx (incl. gst-not-yet-ready 502/503)
    Metadata:     'metadata',     // 503 Retry-After — torrent BT not bootstrapped
    GstOff:       'gst_off',      // /gst/echo failed → GST disabled on server
    Parse:        'parse',        // JSON parse error
    Unknown:      'unknown',
}

// classifyError maps (jqXHR, exception, url) → TorrentError.
// Network exception strings come from $.ajax / xhr's `exception`
// arg ("timeout", "abort", "parsererror", "error", or custom).
function classifyError(jqXHR, exception, url){
    const e = {
        kind: ErrorKind.Unknown,
        httpCode: 0,
        message: '',
        url: url || '',
        retryable: false,
        raw: '',
    }

    if(jqXHR && typeof jqXHR === 'object'){
        e.httpCode = jqXHR.status || 0
        e.raw = (jqXHR.responseText || jqXHR.message || '').toString().slice(0, 500)
        const retryAfter = jqXHR.getResponseHeader && jqXHR.getResponseHeader('Retry-After')
        if(retryAfter){
            e.retryable = true
            e.retryAfter = parseInt(retryAfter, 10) || 0
        }
    }

    if(exception === 'timeout'){
        e.kind = ErrorKind.Timeout
        e.message = 'timeout'
        e.retryable = true
    } else if(exception === 'abort'){
        e.kind = ErrorKind.Network
        e.message = 'aborted'
    } else if(exception === 'parsererror'){
        e.kind = ErrorKind.Parse
        e.message = 'invalid response'
    } else if(e.httpCode === 0){
        // No HTTP response at all → DNS / CORS / offline / wrong port
        e.kind = ErrorKind.Network
        e.message = 'no response (DNS/CORS/offline?)'
    } else if(e.httpCode === 401 || e.httpCode === 403){
        e.kind = ErrorKind.Auth
        e.message = 'unauthorized'
    } else if(e.httpCode === 404){
        e.kind = ErrorKind.NotFound
        e.message = 'not found'
    } else if(e.httpCode === 503){
        // TorrServer uses 503 + Retry-After when BT metadata not ready
        e.kind = ErrorKind.Metadata
        e.message = 'torrent metadata pending'
        e.retryable = true
    } else if(e.httpCode >= 500){
        e.kind = ErrorKind.Server
        e.message = e.raw || 'server error'
        e.retryable = true
    } else if(e.httpCode >= 400){
        e.kind = ErrorKind.Server
        e.message = e.raw || ('http ' + e.httpCode)
    } else if(e.raw){
        e.kind = ErrorKind.Server
        e.message = e.raw
    } else {
        e.message = 'unknown'
    }

    return e
}

// gstErrKind classifies /gst/echo specifically: failure means the
// server's gstreamer pipeline is disabled, not a generic network
// problem. Returned as ErrorKind.GstOff so the UI can suggest the
// right toggle.
function classifyGstEchoError(jqXHR, exception, url){
    const e = classifyError(jqXHR, exception, url)
    if(e.kind === ErrorKind.Network || e.kind === ErrorKind.NotFound){
        e.kind = ErrorKind.GstOff
        e.message = 'gstreamer disabled on server'
    }
    return e
}

// ffprobeErrKind: /ffp/ failing can mean either the endpoint is
// unavailable (server has no gst) or the hash is bogus (400). We
// can't tell from the response alone, but the caller already knows
// gstWork() — pass it in.
function classifyFfprobeError(jqXHR, exception, url, gstEnabled){
    const e = classifyError(jqXHR, exception, url)
    if(!gstEnabled){
        e.kind = ErrorKind.GstOff
        e.message = 'gstreamer disabled on server'
    }
    return e
}

function my(success, fail){
    let data = JSON.stringify({
        action: 'list'
    })

    clear()

    network.silent(url()+'/torrents', (result)=>{
        if(result.length) success(result)
        else fail()
    }, fail, data)
}

function cache(hash, success, fail){
    let data = JSON.stringify({
        action: 'get',
        hash: hash
    })

    network.silent(url()+'/cache', success, fail, data)
}

function add(object, success, fail){
    let send_data = object.data ? Arrays.clone(object.data) : false

    if(send_data && send_data.movie) send_data.movie = Utils.clearCard(send_data.movie)

    let json = {
        action: 'add',
        link: object.link,
        title: '[LAMPA] ' + ((object.title)+'').replace('??', '?'),
        poster: object.poster,
        data: send_data ? JSON.stringify(send_data) : '',
        save_to_db: true,
    }

    let data = JSON.stringify(json)

    clear()

    network.silent(url()+'/torrents', success, fail, data)
}

function hash(object, success, fail){
    let send_data = object.data ? Arrays.clone(object.data) : false

    if(send_data && send_data.movie) send_data.movie = Utils.clearCard(send_data.movie)

    let json = {
        action: 'add',
        link: object.link,
        title: '[LAMPA] ' + ((object.title)+'').replace('??', '?'),
        poster: object.poster,
        data: send_data ? JSON.stringify(send_data) : '',
        save_to_db: Storage.get('torrserver_savedb','false'),
    }

    let data = JSON.stringify(json)

    clear()

    network.silent(url()+'/torrents', success, (a,c)=>{
        fail(network.errorDecode(a,c))
    }, data)
}

function files(hash, success, fail){
    let data = JSON.stringify({
        action: 'get',
        hash: hash
    })

    clear()

    network.timeout(2000)

    network.silent(url()+'/torrents',(json)=>{
        if(json.file_stats){
            success(json)
        }
    }, fail, data)
}

function connected(success, fail){
    clear()

    network.timeout(5000)

    let endpoint = url()+'/settings'

    network.silent(endpoint,(json)=>{
        if(typeof json.CacheSize == 'undefined'){
            fail(classifyError({status: 200, responseText: 'no CacheSize field'}, 'custom', endpoint))
        }
        else{
            success(json)
        }

        gstCheck()
    },(a,c)=>{
        fail(classifyError(a, c, endpoint))
    },JSON.stringify({action: 'get'}))
}

function gstCheck(){
    let endpoint = url()+'/gst/echo'
    network.silent(endpoint,()=>{
        gst_work = true
    },(a,c)=>{
        gst_work = false
        if(typeof console !== 'undefined'){
            console.warn('TorrServer', 'gst/echo failed:', classifyGstEchoError(a, c, endpoint))
        }
    })
}

function gstWork(){
    return Storage.field('torrserver_gts') && gst_work
}

function stream(path, hash, id, ffprobe){
    if(gstWork()) return url() + '/gst/' + encodeURIComponent(hash) + '/master.m3u8?index=' + id + '&audio=0' + DeviceCaps.gstQuerySync(ffprobe)

    return url() + '/stream/'+ encodeURIComponent(path.split('\\').pop().split('/').pop()) +'?link=' + hash + '&index=' + id + '&' + (Storage.field('torrserver_preload') ? 'preload' : 'play')
}

// Per-file ffprobe via TorrServer's /ffp/{hash}/{id}. Resolves to the
// standard ffprobe object ({streams:[...]}) or null on failure / when
// gst is off (no point probing without transcoding). Used by the
// device-capability probe to feed the ACTUAL file's resolution / codec
// to Media Capabilities instead of a torrent-level proxy.
function ffprobe(hash, id){
    return new Promise((resolve)=>{
        if(!gstWork()){
            resolve(null)
            return
        }

        let http = new Request()
        let endpoint = url() + '/ffp/' + encodeURIComponent(hash) + '/' + encodeURIComponent(id)

        http.timeout(15000)

        http.silent(endpoint, (json)=>{
            resolve(json && json.streams ? json : null)
        }, (a, c)=>{
            // 400 on a bogus hash is the *expected* outcome of the
            // endpoint when it works — the server probed and found
            // nothing. /ffp/ failures of every other shape are
            // surfaced to the console; resolution still falls back
            // to torrent-level metadata.
            const err = classifyFfprobeError(a, c, endpoint, gstWork())
            if(typeof console !== 'undefined'){
                console.warn('TorrServer', 'ffprobe failed:', err)
            }
            resolve(null)
        })
    })
}

function drop(hash, success, fail){
    if(gstWork()) return network.silent(url()+'/gst/remove?hash=' + encodeURIComponent(hash), success, fail, data, {dataType: 'text'})

    let data = JSON.stringify({
        action: 'drop',
        hash: hash
    })

    clear()

    network.silent(url()+'/torrents', success, fail, data, {dataType: 'text'})
}

function remove(hash, success, fail){
    let data = JSON.stringify({
        action: 'rem',
        hash: hash
    })

    clear()

    network.silent(url()+'/torrents', success, fail, data, {dataType: 'text'})
}

function parse(data){
    let result = EpisodeParser.parse(data)
        result.hash = Utils.hash(result.hash_string)

    return result
}

function clearFileName(files){
    let combo = []

    files.forEach(element => {
        let spl = element.path.split('/')
        let nam = spl[spl.length - 1].split('.')
        
        if(nam.length > 1) nam.pop()
        
        nam = nam.join('.')
        
        element.path_human = Utils.pathToNormalTitle(nam, false).trim()

        if(spl.length > 1){
            spl.pop()
            
            element.folder_name = Utils.pathToNormalTitle(spl.pop(), false).trim()
        }
    })

    if(files.length > 1){

        files.forEach(element => {
            let spl = element.path_human.split(' ')
            
            for (let i = spl.length - 1; i >= 0; i--) {
                let com = spl.join(' ')

                if(combo.indexOf(com) == -1) combo.push(com)

                spl.pop()
            }
        })

        combo.sort((a,b)=>{
            return a.length > b.length ? -1 : a.length < b.length ? 1 : 0
        })

        for (let i = combo.length - 1; i >= 0; i--) {
            let com = combo[i]
            let len = files.filter(f=>f.path_human.slice(0, com.length) == com).length
            
            if(len < files.length) Arrays.remove(combo, com)
        }

        files.forEach(element => {
            for(let i = 0; i < combo.length; i++){
                let com = combo[i]
                let inx = element.path_human.indexOf(com)

                if(inx >= 0 && com !== element.path_human){
                    element.path_human = element.path_human.slice(com.length).trim()

                    break
                }
            }
        })
    }

    return files
}

function clear(){
    network.clear()
}

// escapeHtml keeps user-supplied error text (URLs, server responses)
// safe when injected into the modal HTML. Anything we display that
// came from the wire must go through here.
function escapeHtml(s){
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

// maskUrlCredentials replaces user:password@ with user:***@ so we
// don't leak credentials into the on-screen modal or the clipboard
// when the user hits "Copy details". The rest of the URL (host,
// port, path, query) is preserved.
function maskUrlCredentials(s){
    if(!s) return s
    try {
        const u = new URL(s)
        if(u.username){
            const cred = u.username + (u.password ? ':' + u.password : '')
            return s.replace(cred + '@', u.username + ':***@')
        }
    } catch(e){
        // not a parseable URL — try a regex fallback for inputs that
        // aren't full URLs (proxies, raw host:port strings).
        return s.replace(/([a-zA-Z0-9._-]+):([^@\s]+)@/, '$1:***@')
    }
    return s
}

function error(reason){
    let temp = Template.get('torrent_error',{ip: ip()})
    let list = temp.find('.torrent-checklist__list > li')
    let info = temp.find('.torrent-checklist__info > div')
    let next = temp.find('.torrent-checklist__next-step')
    let prog = temp.find('.torrent-checklist__progress-bar > div')
    let comp = temp.find('.torrent-checklist__progress-steps')
    let btn  = temp.find('.selector')

    // Surface a typed TorrentError when the caller gave us one. The
    // modal title reflects the category (so the user knows what to
    // check) and a collapsible details block carries the URL + HTTP
    // status + raw message for bug reports.
    let titleKey = 'torrent_error_connect'
    if(reason && reason.kind){
        titleKey = 'torsserver_error_' + reason.kind
    }

    if(reason && (reason.url || reason.message || reason.httpCode)){
        // Mask credentials before any rendering or copy so we don't
        // leak them into the modal or the clipboard.
        const safeUrl = maskUrlCredentials(reason.url)
        const safeReason = Object.assign({}, reason, {url: safeUrl})

        let detailsHtml = '<div class="torrent-checklist__details">'
        detailsHtml += '<div class="torrent-checklist__details-title">' + Lang.translate('torsserver_error_details') + '</div>'
        if(safeUrl){
            detailsHtml += '<div class="torrent-checklist__details-row"><span class="k">URL</span><span class="v">' + escapeHtml(safeUrl) + '</span></div>'
        }
        if(reason.httpCode){
            detailsHtml += '<div class="torrent-checklist__details-row"><span class="k">HTTP</span><span class="v">' + reason.httpCode + '</span></div>'
        }
        if(reason.message){
            detailsHtml += '<div class="torrent-checklist__details-row"><span class="k">Message</span><span class="v">' + escapeHtml(reason.message) + '</span></div>'
        }
        detailsHtml += '</div>'
        temp.find('.torrent-checklist__body').append(detailsHtml)

        // Copy button is NOT a .selector: it has its own handler and
        // must not advance the checklist wizard when activated.
        let copy = $('<div class="torrent-checklist__copy">'+Lang.translate('torsserver_error_copy')+'</div>')
        copy.on('hover:enter', ()=>{
            const payload = JSON.stringify(safeReason, null, 2)
            if(navigator.clipboard && navigator.clipboard.writeText){
                navigator.clipboard.writeText(payload)
                try { Noty.show(Lang.translate('torsserver_error_copied'), {time: 2000}) } catch(e){}
            }
        })
        temp.find('.torrent-checklist__body').append(copy)
    }

    let position = -2

    function makeStep(){
        position++

        list.slice(0, position+1).addClass('wait')

        let total = list.length

        comp.text(Lang.translate('torrent_error_made') + ' ' + Math.max(0,position) + ' '+Lang.translate('torrent_error_from')+' ' + total)

        if(position > list.length){
            Modal.close()

            Controller.toggle('content')
        }
        else if(position >= 0){
            info.addClass('hide')
            info.eq(position).removeClass('hide')

            let next_step = list.eq(position+1)

            prog.css('width', Math.round(position / total * 100) + '%')

            list.slice(0, position).addClass('check')

            btn.text(position < total ? Lang.translate('torrent_error_next')  : Lang.translate('torrent_error_complite'))

            next.text(next_step.length ? '- '+next_step.text() : '')
        }
    }

    makeStep()

    btn.on('hover:enter',()=>{
        makeStep()
    })

    Modal.title(Lang.translate(titleKey))
    Modal.update(temp)

    Controller.add('modal',{
        invisible: true,
        toggle: ()=>{
            Controller.collectionSet(temp)
            Controller.collectionFocus(false,temp)
        },
        back: ()=>{
            Modal.close()

            Controller.toggle('content')
        }
    })

    Controller.toggle('modal')
}

export default {
    ip,
    my,
    add,
    url,
    hash,
    files,
    clear,
    drop,
    stream,
    ffprobe,
    remove,
    connected,
    parse,
    error,
    cache,
    gstWork,
    clearFileName
}
