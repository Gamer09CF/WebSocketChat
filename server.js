const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const adminPassword = 'admin'; // Plaintext password
const connectedUsers = new Map();
const bannedUsers = new Map(); // Store banned user IDs and names
let messages = [];

// Serve the index.html file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Hash the admin password for secure comparison
async function hashPassword(password) {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
}

let hashedAdminPassword;
hashPassword(adminPassword).then(hash => {
    hashedAdminPassword = hash;
    console.log('Admin password hashed and ready.');
});

// Function to broadcast data to all connected clients
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Update the user lists on the client side
function updateUserLists() {
    const usersArray = Array.from(connectedUsers.values()).map(user => ({ id: user.id, name: user.name }));
    const bannedUsersArray = Array.from(bannedUsers.values()).map(user => ({ id: user.id, name: user.name }));
    
    // Send user list to all clients
    broadcast({
        type: 'updateUserLists',
        connectedUsers: usersArray,
        bannedUsers: bannedUsersArray
    });
}

// Handle WebSocket connections
wss.on('connection', ws => {
    console.log('Client connected.');
    ws.user = null; // Store user data directly on the WebSocket connection

    ws.on('message', async message => {
        const data = JSON.parse(message);
        console.log('Received:', data);

        switch (data.type) {
            case 'join':
                // Check if the user is already connected
                if (Array.from(connectedUsers.values()).some(u => u.name === data.userName)) {
                    ws.send(JSON.stringify({
                        type: 'connectionDenied',
                        reason: `The username '${data.userName}' is already taken. Please choose another.`
                    }));
                    return;
                }

                // Check for banned users
                if (Array.from(bannedUsers.values()).some(u => u.name === data.userName)) {
                    ws.send(JSON.stringify({
                        type: 'banned',
                        message: `You have been banned from this chat.`
                    }));
                    return;
                }

                // Handle Admin login
                const isPasswordCorrect = await bcrypt.compare(data.password, hashedAdminPassword);
                if (data.userName === 'Admin' && isPasswordCorrect) {
                    ws.user = { id: Math.random().toString(36).substring(2, 9), name: data.userName, isAdmin: true };
                    connectedUsers.set(ws.user.id, ws.user);
                    ws.send(JSON.stringify({ type: 'joinSuccess', user: ws.user }));
                    ws.send(JSON.stringify({ type: 'chatHistory', messages }));
                    updateUserLists();
                    broadcast({ type: 'newMessage', message: { userName: 'Server', text: `${ws.user.name} has joined the chat.` } });
                } else if (data.userName !== 'Admin') {
                    ws.user = { id: Math.random().toString(36).substring(2, 9), name: data.userName, isAdmin: false };
                    connectedUsers.set(ws.user.id, ws.user);
                    ws.send(JSON.stringify({ type: 'joinSuccess', user: ws.user }));
                    ws.send(JSON.stringify({ type: 'chatHistory', messages }));
                    updateUserLists();
                    broadcast({ type: 'newMessage', message: { userName: 'Server', text: `${ws.user.name} has joined the chat.` } });
                } else {
                    ws.send(JSON.stringify({ type: 'connectionDenied', reason: 'Incorrect admin password.' }));
                }
                break;

            case 'chatMessage':
                if (ws.user) {
                    const message = { userName: ws.user.name, text: data.text, timestamp: new Date(), isAdmin: ws.user.isAdmin };
                    messages.push(message);
                    broadcast({ type: 'newMessage', message });
                }
                break;

            case 'adminMessage':
                if (ws.user && ws.user.isAdmin) {
                    const message = { userName: ws.user.name, text: data.text, timestamp: new Date(), isAdmin: true };
                    messages.push(message);
                    broadcast({ type: 'newMessage', message });
                }
                break;

            case 'banUser':
                if (ws.user && ws.user.isAdmin) {
                    const userToBan = connectedUsers.get(data.userId);
                    if (userToBan) {
                        const clientToBan = Array.from(wss.clients).find(client => client.user && client.user.id === userToBan.id);
                        if (clientToBan) {
                            bannedUsers.set(userToBan.id, userToBan);
                            connectedUsers.delete(userToBan.id);
                            clientToBan.send(JSON.stringify({ type: 'banned', message: 'You have been banned by an admin.' }));
                            clientToBan.close(); // Immediately close the connection
                            broadcast({ type: 'alert', message: `${userToBan.name} has been banned.` });
                            updateUserLists();
                        }
                    }
                }
                break;

            case 'unbanUser':
                if (ws.user && ws.user.isAdmin) {
                    const userToUnban = bannedUsers.get(data.userId);
                    if (userToUnban) {
                        bannedUsers.delete(userToUnban.id);
                        broadcast({ type: 'alert', message: `${userToUnban.name} has been unbanned.` });
                        updateUserLists();
                    }
                }
                break;
            
            case 'clearChat':
                if (ws.user && ws.user.isAdmin) {
                    console.log('Admin requested to clear chat.');
                    messages = []; // Clear the messages array
                    broadcast({ type: 'chatHistory', messages }); // Broadcast the empty history
                    broadcast({ type: 'alert', message: 'The chat has been cleared by an admin.' });
                }
                break;
        }
    });

    ws.on('close', () => {
        if (ws.user) {
            console.log(`Client ${ws.user.name} disconnected.`);
            connectedUsers.delete(ws.user.id);
            broadcast({ type: 'newMessage', message: { userName: 'Server', text: `${ws.user.name} has left the chat.` } });
            updateUserLists();
        } else {
            console.log('A client disconnected before logging in.');
        }
    });

    ws.on('error', error => {
        console.error('WebSocket error:', error);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
