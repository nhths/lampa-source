import Storage from '../core/storage/storage'
import Platform from '../core/platform'
import Base64 from '../utils/base64'
import Noty from '../interaction/noty'
import Utils from '../utils/utils'
import Request from '../utils/reguest'
import Lang from '../core/lang'
import Settings from '../interaction/settings/settings'
import Params from '../interaction/settings/params'
import Template from '../interaction/template'
import TorserverLogs from '../interaction/torserver_logs'

let torrent_net = new Request()

// Register the toggle so the Settings UI shows the current on/off
// state of the "Capture debug logs" preference. The Show-logs button
// is a button-type param (no Storage entry) so it doesn't need a
// Params.trigger entry.
Params.trigger('torrserver_logs_enabled', false)

// Modal template — registered here (close to the wiring that opens
// the modal) so the HTML and its event handlers stay together.
Template.add('lampa_logs', `
<div class="lampa-log">
    <div class="lampa-log__body"></div>
    <div class="lampa-log__footer">
        <div class="simple-button selector lampa-log__refresh">#{settings_server_logs_refresh}</div>
        <div class="simple-button selector lampa-log__clear">#{settings_server_logs_clear}</div>
        <div class="simple-button selector lampa-log__copy">#{settings_server_logs_copy}</div>
        <div class="simple-button selector lampa-log__back">#{cancel}</div>
    </div>
</div>`)

/**
 * Инициализация работы с локальным торрент сервером, проверка доступности и настройка
 * @returns {void}
 */
function init(){
    Storage.listener.follow('change', function (e) {
        if (e.name == 'torrserver_url') check(e.name)
        if (e.name == 'torrserver_url_two') check(e.name)
        if (e.name == 'torrserver_use_link') check(e.value == 'one' ? 'torrserver_url' : 'torrserver_url_two')
        if (e.name == 'torrserver_logs_enabled') TorserverLogs.onEnabledChange()
    })

    Settings.listener.follow('open', function (e){
        if(e.name == 'server'){
            check(Storage.field('torrserver_use_link') == 'one' ? 'torrserver_url' : 'torrserver_url_two')

            // Wire the "Show logs" trigger button: it has data-name
            // torrserver_logs_show in the server template.
            let show = e.body.find('[data-name="torrserver_logs_show"]')
            if(show.length){
                show.off('hover:enter.lampalogs').on('hover:enter.lampalogs', function(){
                    TorserverLogs.show()
                })
            }
        }
        else torrent_net.clear()
    })
}

function check(name) {
    if(Platform.is('android') && !Storage.field('internal_torrclient')) return

    let item = $('[data-name="'+name+'"]').find('.settings-param__status').removeClass('active error wait').addClass('wait')
    let url  = Storage.get(name)

    if(url){
        torrent_net.timeout(10000)

        let head = {dataType: 'text'}
        let auth = Storage.field('torrserver_auth')

        if(auth){
            head.headers = {
                Authorization: "Basic " + Base64.encode(Storage.get('torrserver_login')+':'+Storage.value('torrserver_password'))
            }
        }

        torrent_net.native(Utils.checkEmptyUrl(Storage.get(name)), ()=>{
            item.removeClass('wait').addClass('active')
        }, (a, c)=> {
            if(a.status == 401){
                item.removeClass('wait').addClass('active')

                Noty.show(Lang.translate('torrent_error_check_no_auth') + ' - ' + url, {time: 5000})
            }
            else{
                item.removeClass('wait').addClass('error')

                Noty.show(torrent_net.errorDecode(a, c) + ' - ' + url, {time: 5000})
            }
        }, false, head)
    }
}

export default {
    init
}