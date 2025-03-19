# Zoho CRM Lead Form Handler

This Node.js application handles form submissions and forwards them to Zoho CRM's WebToLead form.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
- Copy `.env.example` to `.env`
- Adjust the `PORT` if needed (default is 3000)

3. Start the server:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## Usage

Update your form's action URL to point to this server's endpoint:

```html
<form action="http://localhost:3000/submit-lead" method="POST">
    <!-- Your form fields -->
</form>
```

The server will forward all form fields to Zoho CRM's WebToLead form and handle the response.

## API Endpoint

POST `/submit-lead`
- Accepts form data
- Returns JSON response with success/error message 