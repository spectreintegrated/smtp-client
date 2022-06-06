# spectre-integrated-smtp-client
This is an SMTP client for use on the same domain as the 'from' email address.\
The domain should at least have an SPF TXT record defined to ensure it passes an authencation check by the recipient mail server.\
Sending from localhost might work depending on the server you're sending to. Typically the first email will pass, but subsequent emails will be blacklisted.

# usage
```js
const smtpClient = require('spectre-integrated-smtp-client')
const mail = new smtpClient({
        to: 'recipient@example.com', // required String
        from: 'noreply@example.com', // required String
        fromName: 'Charles Johannisen', // optional String
        subject: 'This is a subject', // optional String
        message: { // required Object
                text: 'Hi,\n\nThis a text message.\n\nRegards\nCharles',  // optional String
                html: '<b>Hi</b>,<br /><br />This an html message.<br /><br />Regards<br />Charles' // optional String
        },
        upgradeConnection: true, // optional Boolean. Default: true. false will not (attempt to) upgrade the connection to TLS
        attachments: [], // optional Array. see https://nodemailer.com/extras/mailcomposer/#attachments 
        replyTo: 'doreply@example.com', // optional String
        debug: false, // optional Boolean. Default: false. true will print out progress/interaction
        timeout: { // optional Object. Default: {connection: 8000}.
            connection: 8000
        }
})

mail.send() // returns Promise, resolves to {error: null, success: true}
```
