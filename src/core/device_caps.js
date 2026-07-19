import Platform from './platform'

/**
 * Device capabilities probe for TorrServer gstreamer transcoding.
 *
 * Detects what the current environment can play and HOW WELL it plays
 * it, and exposes the result as a query string appended to the
 * /gst/{hash}/master.m3u8 URL:
 *
 *     &v=h264:hw,h265:sw,av1:no&a=aac,ac3
 *
 * Every video codec from the table is reported with a quality tier:
 *   hw — hardware decode (smooth + powerEfficient on a UHD probe):
 *        passthrough always, original quality kept.
 *   sw — playable smoothly at FHD only (software or weak hardware):
 *        passthrough up to 1080p, transcode 4K.
 *   no — unsupported or stutters: transcode always.
 * All table codecs are always sent (explicit `no` beats omission —
 * the server can tell "unsupported" from "not probed").
 *
 * Audio codecs are binary (listed = playable): software audio decode
 * is cheap, so no tiering is needed there.
 *
 * The final quality-vs-smoothness decision lives on the SERVER: it
 * knows the actual file parameters (resolution, bitrate) from its own
 * probe and intersects them with these tiers.
 *
 * Probing has two stages. A synchronous baseline (canPlayType /
 * isTypeSupported — "plays at all", tier 1) is computed lazily on
 * first use and memoized. Where the Media Capabilities API exists, an
 * async refinement upgrades/downgrades tiers per codec; stream URLs
 * built later pick the refined values up automatically. No Storage
 * persistence — probing at load is fast enough.
 */

const VIDEO_MIMES = {
    h264: [
        'video/mp4; codecs="avc1.640028"',  // High 4.0
        'video/mp4; codecs="avc1.4d0028"',  // Main 4.0
        'video/mp4; codecs="avc1.42E01E"'   // Baseline 3.0
    ],
    h265: [
        'video/mp4; codecs="hvc1.1.6.L153.B0"', // Main 5.1
        'video/mp4; codecs="hev1.1.6.L153.B0"',
        'video/mp4; codecs="hvc1.2.4.L153.B0"'  // Main10 5.1
    ],
    av1: [
        'video/mp4; codecs="av01.0.08M.08"',
        'video/mp4; codecs="av01.0.08M.10"'
    ],
    vp9: [
        'video/mp4; codecs="vp09.00.10.08"',
        'video/mp4; codecs="vp09.02.10.10"',    // 10-bit
        'video/webm; codecs="vp9"'
    ],
    vp8: [
        'video/webm; codecs="vp8"',
        'video/mp4; codecs="vp08"'
    ],
    mpeg4: [
        'video/mp4; codecs="mp4v.20.8"'         // MPEG-4 Part 2 (divx/xvid)
    ],
    mpeg2: [
        'video/mpeg',
        'video/mp4; codecs="mp2v"'
    ],
    vc1: [
        'video/mp4; codecs="vc-1"'
    ]
}

const AUDIO_MIMES = {
    aac: [
        'audio/mp4; codecs="mp4a.40.2"',        // AAC-LC
        'audio/mp4; codecs="mp4a.40.5"',        // HE-AAC
        'audio/mp4; codecs="mp4a.40.29"'        // HE-AACv2
    ],
    mp3: [
        'audio/mpeg',
        'audio/mp4; codecs="mp4a.40.34"'
    ],
    ac3: [
        'video/mp4; codecs="ac-3"',
        'audio/mp4; codecs="ac-3"'
    ],
    eac3: [
        'video/mp4; codecs="ec-3"',
        'audio/mp4; codecs="ec-3"'
    ],
    dts: [
        'audio/mp4; codecs="dtsc"',             // DTS core
        'audio/mp4; codecs="dtsh"',             // DTS-HD
        'audio/mp4; codecs="dtse"'              // DTS Express / LBR
    ],
    truehd: [
        'audio/mp4; codecs="mlpa"'              // Dolby TrueHD / MLP
    ],
    flac: [
        'audio/mp4; codecs="fLaC"',
        'audio/flac'
    ],
    opus: [
        'audio/mp4; codecs="Opus"',
        'audio/ogg; codecs="opus"',
        'audio/webm; codecs="opus"'
    ],
    vorbis: [
        'audio/webm; codecs="vorbis"',
        'audio/ogg; codecs="vorbis"'
    ]
}

// Media Capabilities probe profiles. UHD numbers approximate a typical
// 4K remux; FHD — a regular 1080p rip.
const MC_PROBE = {
    uhd: {width: 3840, height: 2160, bitrate: 25e6, framerate: 30},
    fhd: {width: 1920, height: 1080, bitrate: 8e6, framerate: 30}
}

let probed = null      // {v: {codec: tier}, a: [codec, ...]}
let native_hls = null
let refining = false

function detectNativeHls(){
    if(native_hls !== null) return native_hls

    native_hls = false

    try{
        let video = document.createElement('video')
        native_hls = !!(video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl') !== '')
    }
    catch(e){}

    return native_hls
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

function legacyPlatform(){
    // Old TV platforms stub or break canPlayType — don't trust probes
    // there, fall back to static safe defaults.
    return Platform.is('orsay') || Platform.is('netcast')
}

function pickTester(){
    // Probe through the same pipeline that will play the stream:
    // native HLS on TVs/Safari, hls.js (MSE) everywhere else.
    return (detectNativeHls() ? nativeTester() : mseTester()) || nativeTester() || mseTester()
}

function probeBaseline(){
    let caps = {v: {}, a: []}

    if(legacyPlatform()){
        // Pre-2015 TVs: hardware H264 up to FHD, nothing else certain.
        caps.v.h264 = 'sw'
        caps.a.push('aac')
        return caps
    }

    let test = pickTester()

    if(test){
        let any = (mimes)=>mimes.some(test)

        for(let codec in VIDEO_MIMES){
            // Synchronous APIs can't tell hardware from software —
            // conservatively assume sw and let the async Media
            // Capabilities refinement upgrade to hw (or drop to no).
            if(any(VIDEO_MIMES[codec])) caps.v[codec] = 'sw'
        }
        for(let codec in AUDIO_MIMES){
            if(any(AUDIO_MIMES[codec])) caps.a.push(codec)
        }
    }

    // H264 is the transcode target — advertising it is always safe
    // even if the probe lied.
    if(!caps.v.h264) caps.v.h264 = 'sw'

    return caps
}

function mcTier(contentType){
    let type = detectNativeHls() ? 'file' : 'media-source'

    // UHD first: a hardware path answers smooth + powerEfficient.
    // Software may still be smooth at UHD (strong desktop CPU) — that
    // stays sw since it burns the CPU the torrent download needs.
    return navigator.mediaCapabilities.decodingInfo({
        type: type,
        video: Object.assign({contentType: contentType}, MC_PROBE.uhd)
    }).then((uhd)=>{
        if(uhd.supported && uhd.smooth && uhd.powerEfficient) return 'hw'

        return navigator.mediaCapabilities.decodingInfo({
            type: type,
            video: Object.assign({contentType: contentType}, MC_PROBE.fhd)
        }).then((fhd)=>{
            return fhd.supported && fhd.smooth ? 'sw' : 'no'
        })
    })
}

function refine(){
    if(refining || !probed) return
    if(legacyPlatform()) return
    if(!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) return

    refining = true

    // Probe every codec, not just baseline passes: Media Capabilities
    // is newer and more accurate than canPlayType, it may know about
    // support the old APIs deny.
    for(let codec in VIDEO_MIMES){
        mcTier(VIDEO_MIMES[codec][0]).then((tier)=>{
            // H264 is the transcode target — never report no, or
            // the server has nothing safe left to transcode INTO.
            if(codec == 'h264' && tier == 'no') tier = 'sw'

            probed.v[codec] = tier
        }).catch(()=>{
            // decodingInfo rejection — keep the baseline tier.
        })
    }
}

function probe(){
    if(probed) return probed

    probed = probeBaseline()

    refine()

    return probed
}

/**
 * Query string fragment for the /gst/ master.m3u8 URL. Always lists
 * every video codec from the table (`no` when unprobed/unsupported);
 * audio lists only what passed. H264 degrades to sw at worst, so a
 * probe-less environment still yields the safe "transcode everything
 * but h264" descriptor.
 */
function gstQuery(){
    let caps = probe()

    let v = Object.keys(VIDEO_MIMES).map((codec)=>codec + ':' + (caps.v[codec] || 'no'))

    let out = '&v=' + v.join(',')

    if(caps.a.length) out += '&a=' + caps.a.join(',')

    return out
}

export default {
    probe,
    gstQuery
}
