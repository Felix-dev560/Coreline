CoreLine Voice
​CoreLine Voice is a web based real time peer to peer audio calling application built with Node.js, WebSockets, WebRTC, and SQLite. It enables low latency 1 on 1 voice communication directly between devices with user account management and call signaling.
​System Architecture and Features
​Real Time Communication: Direct peer to peer media streaming using the WebRTC API (RTCPeerConnection and getUserMedia).
​Signaling Engine: WebSocket server handling online status, peer discovery, call requests, answers, and ICE candidate exchanges.
​Data Storage: Synchronous local data management via better sqlite3 for user accounts and call history.
​Front End Interface: Native JavaScript and CSS user interface for initiating calls, answering incoming requests, and controlling microphone streams.
​Dependencies
​Node.js v18 or higher
​Node Package Manager
​Project Structure
​server.js: HTTP server, WebSocket signaling logic, and SQLite database initialization.
​public/index.html: Application user interface layout.
​public/app.js: WebRTC stream handling, microphone access, and WebSocket connection state.
​public/styles.css: Interface styling and responsive layout rules.
​Local Installation and Setup
​Clone the repository:
git clone https://github.com/Felix-dev560/CoreLine-Voice.git
​Navigate into the project directory:
cd CoreLine-Voice
​Install all required dependencies:
npm install
​Launch the application server:
npm start
​Access the application in your browser:
http://localhost:3000
​Environment Variables
​Copy env.example to .env if custom environment variables such as PORT or database configuration are required by your deployment target.
​Deployment Notes
​When deploying to a public domain, ensure HTTPS is enabled. WebRTC microphone permissions require a secure context to function outside of localhost.
