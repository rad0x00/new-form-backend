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

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Logger function
const logger = {
    logToFile: (data) => {
        const timestamp = new Date().toISOString();
        const logFile = path.join(logsDir, `${timestamp.split('T')[0]}.log`);
        const logEntry = `[${timestamp}] ${JSON.stringify(data)}\n`;
        
        fs.appendFile(logFile, logEntry, (err) => {
            if (err) console.error('Error writing to log file:', err);
        });
    },
    
    request: (req) => {
        const logData = {
            timestamp: new Date().toISOString(),
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: req.body,
            ip: req.ip,
            userAgent: req.get('user-agent')
        };
        
        console.log('\n=== Incoming Request ===');
        console.log(`Time: ${logData.timestamp}`);
        console.log(`${req.method} ${req.url}`);
        console.log('Headers:', JSON.stringify(req.headers, null, 2));
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('IP:', req.ip);
        console.log('========================\n');
        
        logger.logToFile({ type: 'request', ...logData });
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
    }
};

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
const isValidName = (name) => {
    // Check length (2-40 characters)
    if (name.length < 2 || name.length > 40) {
        return false;
    }

    // Check for too many uppercase letters (more than 3)
    const uppercaseCount = (name.match(/[A-Z]/g) || []).length;
    if (uppercaseCount > 3) {
        return false;
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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Route to handle form submission
app.post('/submit-lead', async (req, res) => {
    try {
        
        // Validate First Name and Last Name
        const firstName = req.body['First Name'];
        const lastName = req.body['Last Name'];

        if (!firstName || !lastName) {
            return res.status(400).json({
                success: false,
                message: 'First Name and Last Name are required'
            });
        }

        if (!isValidName(firstName)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid First Name provided'
            });
        }

        if (!isValidName(lastName)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid Last Name provided'
            });
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