const tls = require('tls')
const net = require('net')
const dns = require('dns')
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
        replyTo
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

        this.domain = to.split('@')[1]
        this.status = ''
        this.currentMx = 0
        this.port = 25
        this.close = false
        this.socket = null
        this.starttls = false
        this.notls = upgradeConnection ? false : true

        this.completed = false
        this.error = null
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
        
        if (typeof response === 'string' && response !== '') {
            this.socket.write(response)
        } else if (Array.isArray(response) && response.length > 0) {
            response.forEach(line => {
                this.socket.write(line)
            })
        } else if (this.close) {
            this.completed = true
            this.socket.destroy()
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
        console.log(`Connection timed out to ${this.host}`)
        this.socket.destroy()
        if (this.currentMx < this.records.length) {
            console.log(`Retry number ${this.currentMx + 1}`)
            this.currentMx++
            this.status = ''
            this.close = false
            this.socket = null
            this.exec()
        } else {
            console.log('No retries left')
            this.error = {
                error: 'All mx records timed out.'
            }
        }
    }

    socketOnClose = () => {
        console.log('Connection closed')
        if (this.currentMx >= this.records.length) {
            this.completed = true
        }
    }

    socketOnError = error => {
        console.log(`ERROR: ${error}`)
        this.completed = true
        this.error = error
    }

    initSocket = () => {
        this.socket.setTimeout(8000)
        this.socket.setEncoding('utf8')
        this.socket.on('data', this.socketOnData)
        this.socket.on('timeout', this.socketOnTimeout)
        this.socket.on('close', this.socketOnClose)
        this.socket.on('error', this.socketOnError)
    }

    exec = async () => {
        if (!this.records) {
            this.records = await this.getMxRecord(this.domain)
        }

        if (!this.socket) {
            this.socket = new net.Socket()
            this.initSocket()
        }
        
        this.host = this.records[this.currentMx]
        this.socket.connect(25, this.host)
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
        let eventTimer
        return new Promise(resolve => {
            this.exec()
            eventTimer = setInterval(() => {
                if (this.completed) {
                    clearInterval(eventTimer)
                    resolve({
                        error: this.error,
                        success: this.error ? false : true
                    })
                }
            }, 500)
        })
    }
}

module.exports = smtp