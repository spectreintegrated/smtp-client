const tls = require('tls')
const net = require('net')
const dns = require('dns')
const EventEmitter = require('events')
const MailComposer = require('nodemailer/lib/mail-composer')

const STARTTLS = 'STARTTLS'
const EHLO = 'EHLO'
const RCPT = 'RCPT'
const DATA = 'DATA'
const QUIT = 'QUIT'

const isEmail = input => {
    const regexp = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return regexp.test(String(input).toLowerCase())
}

class smtp {
    constructor({
        to,
        from,
        fromName,
        subject,
        message: {
            text,
            html
        },
        upgradeConnection = true,
        attachments,
        replyTo,
        debug = false,
        timeout = {
            connection: 8000
        }
    }) {
        if (!isEmail(to) || !isEmail(from)) {
            throw new Error('to/from value must be an email')
        }
        this.to = String(to)
        this.from = String(from)
        this.replyTo = replyTo
        this.fromValue = fromName ? `${fromName} <${this.from}>` : `<${this.from}>`
        this.subject = subject
        this.message = {
            text,
            html
        }
        this.attachments = attachments
        this.hostname = this.from.split('@')[1]
        this.records = null
        this.host = null

        this.domain = this.to.split('@')[1]
        this.status = ''
        this.currentMx = 0
        this.port = 25
        this.close = false
        this.socket = null
        this.starttls = false
        this.upgradeConnection = upgradeConnection
        this.notls = upgradeConnection ? false : true

        this.completed = new EventEmitter()
        this.error = null
        this.debug = debug
        this.timeout = timeout
    }

    resetValues = () => {
        this.starttls = false
        this.notls = this.upgradeConnection ? false : true
        this.status = ''
        this.close = false
    }

    getCode = request => {
        const codePattern = /^[0-9]{3}\s/
        const match = codePattern.exec(request)
        if (match) {
            return parseInt(match[0].trim())
        }

        return 0
    }

    sendResponse = async request => {
        const code = this.getCode(request)
        let response = ''

        switch (code) {
            case 550:
            case 221:
                this.close = true
                break

            case 220:
                if (!this.notls && !this.starttls && this.status === STARTTLS) {
                    this.starttls = true
                    this.status = EHLO
                    // upgrade connection
                    this.socket = tls.connect({socket: this.socket})
                    this.initSocket()
                }
                response = `${EHLO} ${this.hostname}\n`
                break

            case 502:
            case 503:
                if (!this.notls && !this.starttls) {
                    response = `MAIL FROM:<${this.from}>\n`
                    this.status = RCPT
                    this.notls = true
                }
                break

            case 354:
                if (this.status === DATA) {
                    response = await this.buildDataArray()
                    this.status = QUIT
                }
                break

            case 250:
                switch (this.status) {
                    case QUIT:
                    case DATA:
                        response = `${this.status}\n`
                        break
                        
                    case RCPT:
                        response = `RCPT TO:<${this.to}>\n`
                        this.status = DATA
                        break

                    case EHLO:
                        response = `MAIL FROM:<${this.from}>\n`
                        this.status = RCPT
                        break

                    case '':
                        if (!this.notls && !this.starttls) {
                            response = `${STARTTLS}\n`
                            this.status = STARTTLS
                        }
                        break
                }
                break
        }

        this.print({request, code, response})
        
        if (typeof response === 'string' && response !== '') {
            this.socket.write(response)
        } else if (Array.isArray(response) && response.length > 0) {
            response.forEach(line => {
                this.socket.write(line)
            })
        } else if (this.close) {
            this.socket.destroy()
            this.completed.emit('true', true)
        }
    }

    print = log => {
        if (this.debug) {
            console.log(log)
        }
    }

    getMxRecord = domain => {
        return new Promise((resolve, reject) => {
            dns.resolveMx(domain, (err, address) => {
                if (err) {
                    reject(err)
                } else {
                    const records = address.map(({exchange}) => exchange)
                    resolve(records)
                }
            })
        })
    }

    socketOnData = async request => {
        const requestData = request.split('\r\n').reverse()[1]
        this.sendResponse(requestData)
    }

    socketOnTimeout = () => {
        this.print(`Connection timed out to ${this.host}`)
        this.socket.destroy()
        this.currentMx++
        if (this.currentMx < this.records.length) {
            this.print(`Retry number ${this.currentMx + 1}`)
            this.resetValues()
            this.exec()
        } else {
            this.print('No retries left')
            this.completed.emit('true', false, new Error('All mx records timed out.'))
        }
    }

    socketOnClose = () => {
        this.print('Connection closed')
    }

    socketOnError = error => {
        this.print(`ERROR: ${error}`)
        this.completed.emit('true', true, error)
    }

    socketOnLookup = (error, address, family, host) => {
        this.print({lookup: {error, address, family, host}})
    }

    initSocket = () => {
        this.socket.setTimeout(this.timeout.connection)
        this.socket.setEncoding('utf8')
        this.socket.on('data', this.socketOnData)
        this.socket.on('timeout', this.socketOnTimeout)
        this.socket.on('close', this.socketOnClose)
        this.socket.on('error', this.socketOnError)
        this.socket.on('lookup', this.socketOnLookup)
    }

    exec = async () => {
        if (!this.records) {
            this.records = await this.getMxRecord(this.domain)
        }

        this.socket = new net.Socket()
        this.initSocket()
        this.host = this.records[this.currentMx]
        this.socket.connect(this.port, this.host)
    }

    buildDataArray = () => {
        return new Promise(resolve => {
            const message = {
                from: this.fromValue,
                to: this.to,
                replyTo: this.replyTo,
                subject: this.subject,
                text: this.message.text,
                html: this.message.html,
                attachments: this.attachments
            }
            const mail = new MailComposer(message)
            mail.compile().build((err, m) => {
                resolve([
                    ...m.toString().split('\n').map(line => `${line}\n`),
                    '\r\n.\r\n'
                ])
            })
        })
    }

    send = () => {
        this.exec()
        return new Promise(resolve => {
            this.completed.on('true', (success, error) => {
                resolve({
                    error,
                    success
                })
            })
        })
    }
}

module.exports = smtp