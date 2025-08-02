// Import the necessary modules
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const path = require('path');

// --- In-Memory Data Stores ---
// Note: In a real application, this data would be stored in a persistent database.
// For this example, it will be reset every time the server restarts.
let connectedUsers = [];
let bannedUsers = [];
let messages = [];
let featureRequests = [];

// --- Server Configuration ---
const PORT = 8080;
const ADMIN_PASSWORD = 'toor'; // Changed for consistency with the client.

// --- Helper Functions ---
/**
 * Broadcasts a message to all connected clients, optionally filtering by a specific user.
 * @param {object} data - The message data to send.
 * @param {object} [senderWs=null] - The WebSocket of the sender, if a broadcast to all but the sender is needed.
 * @param {boolean} [toAdminsOnly=false] - If true, only broadcasts to admin clients.
 */
function broadcast(data, senderWs = null, toAdminsOnly = false) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            if (toAdminsOnly) {
                if (client.user && client.user.isAdmin) {
                    client.send(message);
                }
            } else if (client !== senderWs) {
                client.send(message);
            }
        }
    });
}

/**
 * Sends a message to a single connected client.
 * @param {object} clientWs - The WebSocket of the client.
 * @param {object} data - The message data to send.
 */
function sendToClient(clientWs, data) {
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(data));
    }
}

/**
 * Gets a user from a list by their ID.
 * @param {Array<Object>} userList - The list of users to search.
 * @param {string} userId - The ID of the user.
 * @returns {Object|null} The user object or null if not found.
 */
function findUserById(userList, userId) {
    return userList.find(u => u.id === userId);
}

/**
 * Removes a user from a list by their ID.
 * @param {Array<Object>} userList - The list of users to modify.
 * @param {string} userId - The ID of the user to remove.
 */
function removeUserById(userList, userId) {
    return userList.filter(u => u.id !== userId);
}

// --- WebSocket Server Setup ---
// Initialize the Express app
const app = express();
// Create an HTTP server using the Express app
const server = http.createServer(app);
// Attach the WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server });

// Serve the index.html file for all GET requests to the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

wss.on('connection', ws => {
    // A flag to check if the user is authenticated and has a username
    ws.isLoggedIn = false;

    ws.on('message', message => {
        const data = JSON.parse(message);

        // A user must first join before sending other messages
        if (!ws.isLoggedIn && data.type !== 'join') {
            sendToClient(ws, { type: 'alert', message: 'You must join the chat first.' });
            return;
        }

        switch (data.type) {
            case 'join':
                const userId = uuidv4();
                const { userName, password } = data;

                // Check for banned users
                const isUserBanned = bannedUsers.some(bannedUser => bannedUser.name === userName);
                if (isUserBanned) {
                    sendToClient(ws, { type: 'banned', message: 'You are banned from this chat.' });
                    ws.close();
                    return;
                }

                // Handle admin login
                if (userName === 'ADMIN' && password === ADMIN_PASSWORD) {
                    ws.user = { id: userId, name: 'ADMIN', isAdmin: true };
                } else if (userName === 'ADMIN' && password !== ADMIN_PASSWORD) {
                    // This line sends the "Incorrect admin password" alert to the client.
                    sendToClient(ws, { type: 'alert', message: 'Incorrect admin password.' });
                    ws.close();
                    return;
                } else {
                    ws.user = { id: userId, name: userName, isAdmin: false };
                }

                ws.isLoggedIn = true;
                connectedUsers.push(ws.user);

                console.log(`${ws.user.name} has joined the chat.`);

                // Send success message and initial data to the new client
                sendToClient(ws, { type: 'joinSuccess', user: ws.user });
                sendToClient(ws, { type: 'chatHistory', messages });
                if (ws.user.isAdmin) {
                    sendToClient(ws, { type: 'updateFeatureRequests', requests: featureRequests });
                }
                
                // Update all clients with the new user lists
                broadcast({
                    type: 'updateUserLists',
                    connectedUsers: connectedUsers,
                    bannedUsers: bannedUsers
                });
                break;

            case 'chatMessage':
                const newMessage = {
                    id: uuidv4(),
                    userId: ws.user.id,
                    userName: ws.user.name,
                    text: data.text,
                    timestamp: new Date().toISOString()
                };
                messages.push(newMessage);
                console.log(`New message from ${ws.user.name}: ${data.text}`);
                
                // Broadcast the new message to all clients. This ensures the message is sent
                // once, and the sender receives their own message along with everyone else.
                broadcast({ type: 'newMessage', message: newMessage });
                break;
            
            case 'banUser':
                if (ws.user.isAdmin) {
                    const userToBan = findUserById(connectedUsers, data.userId);
                    if (userToBan) {
                        bannedUsers.push(userToBan);
                        connectedUsers = removeUserById(connectedUsers, data.userId);
                        console.log(`Admin ${ws.user.name} has banned user: ${userToBan.name}`);

                        // Find the WebSocket for the user being banned and send them a 'banned' message
                        const bannedClientWs = Array.from(wss.clients).find(client => client.user && client.user.id === data.userId);
                        if (bannedClientWs) {
                            sendToClient(bannedClientWs, { type: 'banned' });
                            bannedClientWs.close();
                        }
                        
                        // Update all clients with the new user lists
                        broadcast({
                            type: 'updateUserLists',
                            connectedUsers: connectedUsers,
                            bannedUsers: bannedUsers
                        });
                    }
                } else {
                    sendToClient(ws, { type: 'alert', message: 'You are not authorized to perform this action.' });
                }
                break;

            case 'unbanUser':
                if (ws.user.isAdmin) {
                    const userToUnban = findUserById(bannedUsers, data.userId);
                    if (userToUnban) {
                        bannedUsers = removeUserById(bannedUsers, data.userId);
                        console.log(`Admin ${ws.user.name} has unbanned user: ${userToUnban.name}`);

                        // Update all clients with the new user lists
                        broadcast({
                            type: 'updateUserLists',
                            connectedUsers: connectedUsers,
                            bannedUsers: bannedUsers
                        });
                    }
                } else {
                    sendToClient(ws, { type: 'alert', message: 'You are not authorized to perform this action.' });
                }
                break;

            case 'featureRequest':
                if (ws.user.isAdmin) {
                    sendToClient(ws, { type: 'alert', message: 'Admins cannot submit feature requests.' });
                    return;
                }
                const newRequest = {
                    id: uuidv4(),
                    userId: ws.user.id,
                    userName: ws.user.name,
                    text: data.text,
                    timestamp: new Date().toISOString()
                };
                featureRequests.push(newRequest);
                console.log(`New feature request from ${ws.user.name}: ${data.text}`);
                
                // Only broadcast to admins so they can see the new request
                broadcast({ type: 'updateFeatureRequests', requests: featureRequests }, null, true);
                break;
                
            case 'deleteFeatureRequest':
                if (ws.user.isAdmin) {
                    featureRequests = featureRequests.filter(request => request.id !== data.requestId);
                    console.log(`Admin ${ws.user.name} deleted feature request: ${data.requestId}`);
                    
                    // Update all admins with the new list of feature requests
                    broadcast({ type: 'updateFeatureRequests', requests: featureRequests }, null, true);
                } else {
                    sendToClient(ws, { type: 'alert', message: 'You are not authorized to perform this action.' });
                }
                break;

            default:
                console.warn('Unknown message type:', data.type);
                break;
        }
    });

    ws.on('close', () => {
        if (ws.user) {
            connectedUsers = removeUserById(connectedUsers, ws.user.id);
            console.log(`${ws.user.name} has left the chat.`);
            // Update all clients with the new user lists
            broadcast({
                type: 'updateUserLists',
                connectedUsers: connectedUsers,
                bannedUsers: bannedUsers
            });
        }
    });

    ws.on('error', error => {
                console.error('WebSocket error:', error);
            });
        });
        
        server.listen(PORT, () => {
            console.log(`WebSocket server started on port ${PORT}`);
        });
