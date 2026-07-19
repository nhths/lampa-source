import Platform from './platform'

/**
 * Device capability probe for TorrServer gstreamer transcoding.
 *
 * Probes whether the current environment can decode a SPECIFIC file's
 * codecs at its real resolution / bitrate / framerate, and exposes the
 * result as a query string appended to the /gst/{hash}/master.m3u8 URL:
 *
 *     &v=h264:hw,h265:no,av1:sw&a=aac,ac3
 *
 * Every video codec present in the file is reported with a tier:
 *   hw — smooth + powerEfficient at this file's resolution: hardware
 *        decode, passthrough keeps original quality.
 *   sw — smooth but not powerEfficient: software or weak-hardware
 *        decode that keeps up; passthrough still ok.
 *   no — not supported or stutters: transcode.
 * Audio codecs present in the file are listed when the client can
 * decode them (binary — software audio decode is cheap).
 *
 * The probe feeds the file's real params (from its ffprobe) to the
 * Media Capabilities API, so the tier is accurate for THAT file: a
 * device that decodes HEVC smoothly at 1080p but chokes on 4K gets
 * different tiers for the two files. Movies are typically 24fps; the
 * file's own avg_frame_rate is used when present.
 *
 * Two-stage:
 *   gstQuerySync(ffprobe) — synchronous, returns the cached result or
 *     a canPlayType baseline (hw/sw unknown → "plays at all" → sw).
 *     Safe for the first read before the async probe warms.
 *   ensureProbed(ffprobe) — async Promise that runs decodingInfo per
 *     codec against the file's real params and caches the result.
 *     Call this at the play click, before building the stream URL.
 *
 * Results are memoized by file params (w×h×bitrate×fps) so re-entering
 * a file or seeking reuses them. No Storage persistence.
 */

// ffprobe video codec_name -> Lampa codec key -> mime variants.
// Each codec counts as supported when ANY mime variant passes.
const VIDEO_CODECS = {
    h264: {
        ffprobe: ['h264'],
        mimes: [
            'video/mp4; codecs="avc1.640028"',  // High 4.0
            'video/mp4; codecs="avc1.4d0028"',  // Main 4.0
            'video/mp4; codecs="avc1.42E01E"'   // Baseline 3.0
        ]
    },
    h265: {
        ffprobe: ['hevc', 'h265'],
        mimes: [
            'video/mp4; codecs="hvc1.1.6.L153.B0"', // Main 5.1
            'video/mp4; codecs="hev1.1.6.L153.B0"',
            'video/mp4; codecs="hvc1.2.4.L153.B0"'  // Main10 5.1
        ]
    },
    av1: {
        ffprobe: ['av1'],
        mimes: [
            'video/mp4; codecs="av01.0.08M.08"',
            'video/mp4; codecs="av01.0.08M.10"'
        ]
    },
    vp9: {
        ffprobe: ['vp9'],
        mimes: [
            'video/mp4; codecs="vp09.00.10.08"',
            'video/mp4; codecs="vp09.02.10.10"',    // 10-bit
            'video/webm; codecs="vp9"'
        ]
    },
    vp8: {
        ffprobe: ['vp8'],
        mimes: [
            'video/webm; codecs="vp8"',
            'video/mp4; codecs="vp08"'
        ]
    },
    mpeg4: {
        ffprobe: ['mpeg4', 'msmpeg4', 'divx', 'xvid'],
        mimes: ['video/mp4; codecs="mp4v.20.8"']
    },
    mpeg2: {
        ffprobe: ['mpeg2video', 'mpeg2'],
        mimes: ['video/mpeg', 'video/mp4; codecs="mp2v"']
    },
    vc1: {
        ffprobe: ['vc1', 'wmv3'],
        mimes: ['video/mp4; codecs="vc-1"']
    }
}

// ffprobe audio codec_name -> mime variants.
const AUDIO_CODECS = {
    aac:     {ffprobe: ['aac'],           mimes: ['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="mp4a.40.5"', 'audio/mp4; codecs="mp4a.40.29"']},
    mp3:     {ffprobe: ['mp3'],           mimes: ['audio/mpeg', 'audio/mp4; codecs="mp4a.40.34"']},
    ac3:     {ffprobe: ['ac3'],           mimes: ['video/mp4; codecs="ac-3"', 'audio/mp4; codecs="ac-3"']},
    eac3:    {ffprobe: ['eac3'],          mimes: ['video/mp4; codecs="ec-3"', 'audio/mp4; codecs="ec-3"']},
    dts:     {ffprobe: ['dts', 'dts-hd', 'dts_hd'], mimes: ['audio/mp4; codecs="dtsc"', 'audio/mp4; codecs="dtsh"', 'audio/mp4; codecs="dtse"']},
    truehd:  {ffprobe: ['truehd'],        mimes: ['audio/mp4; codecs="mlpa"']},
    flac:    {ffprobe: ['flac'],          mimes: ['audio/mp4; codecs="fLaC"', 'audio/flac']},
    opus:    {ffprobe: ['opus'],          mimes: ['audio/mp4; codecs="Opus"', 'audio/webm; codecs="opus"']},
    vorbis:  {ffprobe: ['vorbis'],        mimes: ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"']}
}

let cache = {}        // paramsKey -> {v: {codec: tier}, a: [codec]}
let probing = {}      // paramsKey -> Promise

function legacyPlatform(){
    // Old TV platforms stub or break canPlayType — static safe defaults.
    return Platform.is('orsay') || Platform.is('netcast')
}

function detectNativeHls(){
    try{
        let video = document.createElement('video')
        return !!(video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl') !== '')
    }
    catch(e){
        return false
    }
}

function nativeTester(){
    let video = document.createElement('video')

    if(typeof video.canPlayType !== 'function') return null

    return (mime)=>{
        try{
            return video.canPlayType(mime) !== ''
        }
        catch(e){
            return false
        }
    }
}

function mseTester(){
    if(!window.MediaSource || typeof MediaSource.isTypeSupported !== 'function') return null

    return (mime)=>{
        try{
            return MediaSource.isTypeSupported(mime)
        }
        catch(e){
            return false
        }
    }
}

function pickTester(){
    // Probe through the same pipeline that will play the stream:
    // native HLS on TVs/Safari, hls.js (MSE) everywhere else.
    return (detectNativeHls() ? nativeTester() : mseTester()) || nativeTester() || mseTester()
}

// --- ffprobe param extraction ---

function parseFramerate(rate){
    // ffprobe avg_frame_rate is "num/den" (e.g. "24000/1001").
    if(!rate || typeof rate != 'string') return 24

    let parts = rate.split('/')

    if(parts.length == 2){
        let num = parseFloat(parts[0])
        let den = parseFloat(parts[1])

        if(den > 0 && num > 0) return Math.round(num / den)
    }

    let n = parseFloat(rate)

    return n > 0 ? Math.round(n) : 24
}

function videoStream(ffprobe){
    if(!ffprobe || !ffprobe.length) return null

    return ffprobe.find((s)=>s && s.codec_type == 'video') || null
}

function audioStreams(ffprobe){
    if(!ffprobe || !ffprobe.length) return []

    return ffprobe.filter((s)=>s && s.codec_type == 'audio')
}

function extractParams(ffprobe){
    let video = videoStream(ffprobe)

    if(!video) return null

    let width = parseInt(video.width, 10) || 1920
    let height = parseInt(video.height, 10) || 1080
    let framerate = parseFramerate(video.avg_frame_rate || video.r_frame_rate)

    let bitrate = parseInt(video.bit_rate, 10) || 0

    // Fall back to size/duration if bit_rate is absent (common for
    // mkv). ffprobe duration is seconds; size is bytes.
    if(!bitrate && video.duration){
        let bytes = parseInt(video.size, 10) || 0

        if(bytes && video.duration > 0) bitrate = Math.round(bytes * 8 / video.duration)
    }

    if(!bitrate) bitrate = Math.round(width * height * framerate * 0.1) // rough heuristic

    return {width, height, framerate, bitrate, codec: (video.codec_name || '').toLowerCase()}
}

function paramsKey(params){
    return params.width + 'x' + params.height + 'x' + params.bitrate + 'x' + params.framerate
}

// --- codec lookup ---

function findVideoKey(codecName){
    for(let key in VIDEO_CODECS){
        if(VIDEO_CODECS[key].ffprobe.indexOf(codecName) >= 0) return key
    }

    return null
}

function findAudioKey(codecName){
    for(let key in AUDIO_CODECS){
        if(AUDIO_CODECS[key].ffprobe.indexOf(codecName) >= 0) return key
    }

    return null
}

// --- sync baseline ---

function baseline(ffprobe){
    let caps = {v: {}, a: []}

    if(legacyPlatform()){
        caps.v.h264 = 'sw'
        caps.a.push('aac')
        return caps
    }

    let test = pickTester()

    if(!test) return caps

    let video = videoStream(ffprobe)

    if(video){
        let key = findVideoKey((video.codec_name || '').toLowerCase())

        if(key){
            // canPlayType can't tell hw from sw — assume sw conservatively.
            if(VIDEO_CODECS[key].mimes.some(test)) caps.v[key] = 'sw'
        }

        // h264 is the transcode target — always advertise it.
        if(!caps.v.h264) caps.v.h264 = 'sw'
    }

    audioStreams(ffprobe).forEach((s)=>{
        let key = findAudioKey((s.codec_name || '').toLowerCase())

        if(key && AUDIO_CODECS[key].mimes.some(test) && caps.a.indexOf(key) === -1) caps.a.push(key)
    })

    return caps
}

// --- async refinement via Media Capabilities ---

function mcTierFor(contentType, params){
    let type = detectNativeHls() ? 'file' : 'media-source'
    let query = {
        type: type,
        video: {
            contentType: contentType,
            width: params.width,
            height: params.height,
            bitrate: params.bitrate,
            framerate: params.framerate
        }
    }

    return navigator.mediaCapabilities.decodingInfo(query).then((info)=>{
        if(!info.supported) return 'no'
        if(info.smooth && info.powerEfficient) return 'hw'
        if(info.smooth) return 'sw'

        return 'no'
    }).catch(()=>null)
}

function runProbe(ffprobe, params){
    let caps = baseline(ffprobe)

    if(legacyPlatform()) return Promise.resolve(caps)

    if(!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo){
        return Promise.resolve(caps)
    }

    let video = videoStream(ffprobe)
    let tasks = []

    // Probe the file's actual video codec(s) against the real params.
    if(video){
        let key = findVideoKey((video.codec_name || '').toLowerCase())

        if(key){
            tasks.push(mcTierFor(VIDEO_CODECS[key].mimes[0], params).then((tier)=>{
                if(tier){
                    if(key == 'h264' && tier == 'no') tier = 'sw'

                    caps.v[key] = tier
                }
            }))
        }

        // Always probe h264 too (transcode target) so the server knows
        // whether even the fallback will play smoothly.
        if(key != 'h264'){
            tasks.push(mcTierFor(VIDEO_CODECS.h264.mimes[0], params).then((tier)=>{
                if(tier){
                    if(tier == 'no') tier = 'sw'

                    caps.v.h264 = tier
                }
            }))
        }
    }

    return Promise.all(tasks).then(()=>caps)
}

// --- public API ---

function ensureProbed(ffprobe){
    let params = extractParams(ffprobe)

    if(!params) return Promise.resolve()

    let key = paramsKey(params)

    if(cache[key]) return Promise.resolve()

    if(probing[key]) return probing[key]

    probing[key] = runProbe(ffprobe, params).then((caps)=>{
        cache[key] = caps
    }).finally(()=>{
        delete probing[key]
    })

    return probing[key]
}

function gstQuerySync(ffprobe){
    let params = extractParams(ffprobe)
    let caps = params && cache[paramsKey(params)]

    if(!caps) caps = baseline(ffprobe)

    let v = Object.keys(caps.v).map((codec)=>codec + ':' + caps.v[codec])

    let out = ''

    if(v.length) out += '&v=' + v.join(',')
    if(caps.a.length) out += '&a=' + caps.a.join(',')

    return out
}

/**
 * Async full probe. Returns the query string after running decodingInfo
 * against the file's real params. Memoized so repeated reads are free.
 */
function gstQuery(ffprobe){
    return ensureProbed(ffprobe).then(()=>gstQuerySync(ffprobe))
}

export default {
    ensureProbed,
    gstQuery,
    gstQuerySync
}
