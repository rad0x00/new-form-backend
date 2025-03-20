const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dotenv = require('dotenv');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

dotenv.config();

const app = express();
const httpPort = process.env.HTTP_PORT || 3000;
const httpsPort = process.env.HTTPS_PORT || 3443;
const enableHttps = process.env.ENABLE_HTTPS === 'true';
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Logger function
const logger = {
    sendToSlack: async (message) => {
        if (!slackWebhookUrl) return;

        try {
            await axios.post(slackWebhookUrl, {
                text: typeof message === 'string' ? message : JSON.stringify(message, null, 2)
            });
        } catch (error) {
            console.error('Error sending to Slack:', error.message);
        }
    },

    logToFile: (data) => {
        const timestamp = new Date().toISOString();
        const logFile = path.join(logsDir, `${timestamp.split('T')[0]}.log`);
        const logEntry = `[${timestamp}] ${JSON.stringify(data)}\n`;
        
        fs.appendFile(logFile, logEntry, (err) => {
            if (err) console.error('Error writing to log file:', err);
        });

        // Send important logs to Slack
        if (data.type === 'error' || data.type === 'zoho_request' || data.type === 'zoho_response') {
            const slackMessage = {
                type: data.type,
                timestamp: timestamp,
                ...data
            };
            logger.sendToSlack({
                text: `*${data.type.toUpperCase()}*`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*${data.type.toUpperCase()}*\n${JSON.stringify(data, null, 2)}`
                        }
                    }
                ]
            });
        }
    },
    
    request: (req) => {
        const logData = {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: {
                parsed: req.body,
                query: req.query,
                params: req.params
            },
            ip: req.ip,
            userAgent: req.get('user-agent')
        };

        // If it's a form submission, include form data
        if (req.is('application/x-www-form-urlencoded')) {
            logData.body.formData = Object.fromEntries(
                Object.entries(req.body).map(([key, value]) => [key, value])
            );
        }
        
        console.log('\n=== Incoming Request ===');
        console.log(`Time: ${logData.timestamp}`);
        console.log(`${req.method} ${req.url}`);
        console.log('Headers:', JSON.stringify(req.headers, null, 2));
        console.log('Body:', JSON.stringify(logData.body, null, 2));
        console.log('IP:', req.ip);
        console.log('========================\n');
        
        logger.logToFile({ type: 'request', ...logData });

        // Send form submissions to Slack
        if (req.method === 'POST' && req.url === '/submit-lead') {
            logger.sendToSlack({
                text: `*NEW LEAD SUBMISSION*`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*New Lead Submission*\nTime: ${logData.timestamp}\nIP: ${req.ip}\nForm Data:\n\`\`\`${JSON.stringify(logData.body.formData || req.body, null, 2)}\`\`\``
                        }
                    }
                ]
            });
        }
    },
    
    response: (req, res, data) => {
        const logData = {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            responseData: data,
            processingTime: Date.now() - req._startTime
        };
        
        console.log('\n=== Outgoing Response ===');
        console.log(`Time: ${logData.timestamp}`);
        console.log(`${req.method} ${req.url}`);
        console.log('Status:', res.statusCode);
        console.log('Response:', JSON.stringify(data, null, 2));
        console.log('Processing Time:', logData.processingTime, 'ms');
        console.log('========================\n');
        
        logger.logToFile({ type: 'response', ...logData });

        // Send failed responses to Slack
        if (res.statusCode >= 400) {
            logger.sendToSlack({
                text: `*FAILED RESPONSE*`,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*Failed Response*\nStatus: ${res.statusCode}\nURL: ${req.url}\nMethod: ${req.method}\nResponse: ${JSON.stringify(data, null, 2)}`
                        }
                    }
                ]
            });
        }
    },
    
    error: (req, error) => {
        const logData = {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.url,
            error: {
                message: error.message,
                stack: error.stack
            }
        };
        
        console.error('\n=== Error ===');
        console.error(`Time: ${logData.timestamp}`);
        console.error(`${req.method} ${req.url}`);
        console.error('Error:', error);
        console.error('=============\n');
        
        logger.logToFile({ type: 'error', ...logData });

        // Send errors to Slack
        logger.sendToSlack({
            text: `*ERROR ALERT*`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Error Alert*\nURL: ${req.url}\nMethod: ${req.method}\nError: ${error.message}\nStack: ${error.stack}`
                    }
                }
            ]
        });
    }
};

// Middleware
app.use(cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add request timestamp middleware
app.use((req, res, next) => {
    req._startTime = Date.now();
    next();
});

// Add logging middleware
app.use((req, res, next) => {
    logger.request(req);
    
    // Capture and log the response
    const originalJson = res.json;
    res.json = function(data) {
        logger.response(req, res, data);
        return originalJson.call(this, data);
    };
    
    next();
});

// SSL configuration
const sslOptions = enableHttps ? {
    cert: fs.readFileSync(path.join(__dirname, '../fullchain.pem')),
    key: fs.readFileSync(path.join(__dirname, '../privkey.pem')),
    minVersion: 'TLSv1.2',
    requestCert: false,
    rejectUnauthorized: false
} : null;

// Create custom HTTPS agent with permissive SSL/TLS options for local development
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    cert: enableHttps ? fs.readFileSync(path.join(__dirname, '../fullchain.pem')) : null,
    key: enableHttps ? fs.readFileSync(path.join(__dirname, '../privkey.pem')) : null
});

// Configure axios defaults
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.proxy = false;

// Add error handler for SSL errors
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Add TLS debugging
const tlsDebug = (info) => {
    console.log('TLS Debug:', {
        protocol: info.protocol,
        cipher: info.cipher
    });
};

// Validation helper functions
const isValidEmail = (email) => {
    if (!email) return false;
    
    // More comprehensive email regex that supports subdomains and country TLDs
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    
    // Check basic format
    if (!emailRegex.test(email)) {
        return false;
    }

    // Additional checks
    try {
        // Check length
        if (email.length > 254) return false;

        // Split email into local and domain parts
        const [local, domain] = email.split('@');

        // Check lengths of parts
        if (local.length > 64) return false;
        if (domain.length > 255) return false;

        // Check if domain has at least one dot
        if (!domain.includes('.')) return false;

        return true;
    } catch (e) {
        return false;
    }
};

const isValidAUName = (name) => {
    // Check length (2-40 characters)
    if (name.length < 2 || name.length > 40) {
        return false;
    }

    // Check if it's a single word
    const words = name.trim().split(/\s+/);
    if (words.length === 1) {
        // For single words, only allow one uppercase character
        const uppercaseCount = (name.match(/[A-Z]/g) || []).length;
        if (uppercaseCount > 1) {
            return false;
        }
    } else {
        // For multiple words, maintain the original uppercase limit
        const uppercaseCount = (name.match(/[A-Z]/g) || []).length;
        if (uppercaseCount > 3) {
            return false;
        }
    }

    // Check if contains valid characters (letters, spaces, hyphens, apostrophes)
    if (!/^[A-Za-z\s\-']+$/.test(name)) {
        return false;
    }

    // Check for repeated characters (more than 3 times)
    if (/(.)\1{2,}/.test(name)) {
        return false;
    }

    // Check for keyboard patterns
    const keyboardPatterns = [
        'qwerty', 'asdfgh', 'zxcvbn', 'qwertz', 'azerty',
        'asdf', 'qwer', 'wasd', 'DBYIfQEamAQ', 'UNwcUIwDb'
    ];
    const lowerName = name.toLowerCase();
    if (keyboardPatterns.some(pattern => lowerName.includes(pattern))) {
        return false;
    }

    // Check for reasonable word structure (must contain at least one vowel)
    if (!/[aeiou]/i.test(name)) {
        return false;
    }

    return true;
};

const isValidNZName = (name) => {
    // Check length (2-40 characters)
    if (name.length < 2 || name.length > 40) {
        return false;
    }

    // Check if it's a single word
    const words = name.trim().split(/\s+/);
    if (words.length === 1) {
        // For single words, only allow one uppercase character
        const uppercaseCount = (name.match(/[A-Z]/g) || []).length;
        if (uppercaseCount > 1) {
            return false;
        }
    }

    // Allow Māori macrons in addition to standard characters
    if (!/^[A-Za-zĀāĒēĪīŌōŪū\s\-']+$/.test(name)) {
        return false;
    }

    // Check for repeated characters (more than 3 times)
    if (/(.)\1{2,}/.test(name)) {
        return false;
    }

    // Check for keyboard patterns
    const keyboardPatterns = [
        'qwerty', 'asdfgh', 'zxcvbn', 'qwertz', 'azerty',
        'asdf', 'qwer', 'wasd', 'DBYIfQEamAQ', 'UNwcUIwDb'
    ];
    const lowerName = name.toLowerCase();
    if (keyboardPatterns.some(pattern => lowerName.includes(pattern))) {
        return false;
    }

    // Check for vowels (including Māori vowels)
    if (!/[aeiouāēīōū]/i.test(name)) {
        return false;
    }

    return true;
};

// Australian mobile number validation
const isValidAUMobile = (mobile) => {
    // Remove spaces and any other non-digit characters
    const cleanMobile = mobile.replace(/\D/g, '');
    
    // Check if it starts with 04 and has 10 digits total
    // or starts with +614 and has 11 digits total
    return /^04\d{8}$/.test(cleanMobile) || /^\+614\d{8}$/.test(cleanMobile);
};

// New Zealand mobile number validation
const isValidNZMobile = (mobile) => {
    // Remove spaces and any other non-digit characters
    const cleanMobile = mobile.replace(/\D/g, '');
    
    // Check if it starts with 02 and has 9-10 digits total
    // or starts with +642 and has 10-11 digits total
    return /^02\d{7,8}$/.test(cleanMobile) || /^\+642\d{7,8}$/.test(cleanMobile);
};

// Route to handle form submission
app.post('/submit-lead', async (req, res) => {
    try {
        // Validate First Name and Last Name
        const firstName = req.body['First Name'];
        const lastName = req.body['Last Name'];
        const mobile = req.body['Phone'];
        const leadSource = req.body['Lead Source'];
        const amount = parseFloat(req.body['LEADCF66']);
        const email = req.body['Email'];

        if (!firstName || !lastName) {
            return res.status(400).json({
                success: false,
                message: 'First Name and Last Name are required'
            });
        }

        // Validate Email
        if (!isValidEmail(email)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email address format'
            });
        }

        // Validate Amount
        if (!amount || amount === 0) {
            return res.status(400).json({
                success: false,
                message: 'Amount is required and must be greater than 0'
            });
        }

        // Name validation based on Lead Source
        if (leadSource === 'WebForm-AU') {
            if (!isValidAUName(firstName)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid First Name format for Australian submission'
                });
            }
            if (!isValidAUName(lastName)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid Last Name format for Australian submission'
                });
            }
        } else {
            if (!isValidNZName(firstName)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid First Name format for New Zealand submission. Name may include Māori characters (e.g., ā, ē, ī, ō, ū)'
                });
            }
            if (!isValidNZName(lastName)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid Last Name format for New Zealand submission. Name may include Māori characters (e.g., ā, ē, ī, ō, ū)'
                });
            }
        }

        // Mobile number validation based on Lead Source
        if (mobile) {
            if (leadSource === 'WebForm-AU') {
                if (!isValidAUMobile(mobile)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid Australian mobile number format. Please enter a valid Australian mobile number (e.g., 0412345678 or +61412345678)'
                    });
                }
            } else {
                if (!isValidNZMobile(mobile)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid New Zealand mobile number format. Please enter a valid New Zealand mobile number (e.g., 0211234567 or +64211234567)'
                    });
                }
            }
        }
        
        const formData = new URLSearchParams();
        
        // Add all form fields to formData
        Object.keys(req.body).forEach(key => {
            formData.append(key, req.body[key]);
        });

        // Add static hidden fields
        formData.append('xnQsjsdp', '6ca8eb79be6df6c6995034066b42682930568fe7caaa0396d9b5ca24410f07c8');
        formData.append('xmIwtLD', '0e7f49d2b39f4cd6689800c52837b699d53a1880dbe13f819ceb8d04cf07b77e1078d30ad9fa662ad313d07224698637');
        formData.append('actionType', 'TGVhZHM=');
        formData.append('returnURL', 'https://homesec.com.au/thank-you');
        formData.append('zc_gad', '');
        formData.append('ldeskuid', '');
        formData.append('LDTuvid', '');

        // Log the Zoho CRM request
        logger.logToFile({
            type: 'zoho_request',
            timestamp: new Date().toISOString(),
            url: 'https://crm.zoho.com.au/crm/WebToLeadForm',
            formData: Object.fromEntries(formData)
        });

        const response = await axios.post(
            'https://crm.zoho.com.au/crm/WebToLeadForm',
            formData,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                httpsAgent: httpsAgent
            }
        );

        // Log the Zoho CRM response
        logger.logToFile({
            type: 'zoho_response',
            timestamp: new Date().toISOString(),
            status: response.status,
            data: response.data
        });

        res.status(200).json({
            success: true,
            message: 'Lead submitted successfully'
        });
    } catch (error) {
        logger.error(req, error);
        res.status(500).json({
            success: false,
            message: 'Error submitting lead',
            error: error.message
        });
    }
});

// Create servers based on configuration
if (enableHttps) {
    // Create HTTPS server
    const httpsServer = https.createServer(sslOptions, app);

    // Add TLS error handling
    httpsServer.on('tlsClientError', (err, tlsSocket) => {
        console.error('TLS Client Error:', err);
        logger.logToFile({
            type: 'tls_error',
            timestamp: new Date().toISOString(),
            error: err.message
        });
    });

    httpsServer.on('secureConnection', (tlsSocket) => {
        console.log('Secure Connection Established');
        logger.logToFile({
            type: 'tls_connection',
            timestamp: new Date().toISOString(),
            message: 'Secure Connection Established'
        });
    });

    httpsServer.listen(httpsPort, () => {
        console.log(`HTTPS Server is running on port ${httpsPort}`);
        console.log('Note: For local development, you may need to accept the self-signed certificate in your browser.');
        logger.logToFile({
            type: 'server_start',
            timestamp: new Date().toISOString(),
            protocol: 'HTTPS',
            port: httpsPort
        });
    });
}

// Create HTTP server
const httpServer = http.createServer(app);
httpServer.listen(httpPort, () => {
    console.log(`HTTP Server is running on port ${httpPort}`);
    logger.logToFile({
        type: 'server_start',
        timestamp: new Date().toISOString(),
        protocol: 'HTTP',
        port: httpPort
    });
}); 