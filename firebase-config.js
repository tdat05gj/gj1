import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

const encodedFirebaseConfig = "eyJhcGlLZXkiOiJBSXphU3lCam9GQUFyRVZBZkZHSEhlTEwtV0M0cldMLUhDaDZKeHhFIiwiYXV0aERvbWFpbiI6ImdqcHJvamVjdDEtMzdlMjkuZmlyZWJhc2VhcHAuY29tIiwicHJvamVjdElkIjoiZ2pwcm9qZWN0MS0zN2UyOSIsInN0b3JhZ2VCdWNrZXQiOiJnanByb2plY3QxLTM3ZTI5LmZpcmViYXNlc3RvcmFnZS5hcHAiLCJtZXNzYWdpbmdTZW5kZXJJZCI6IjczMzY1ODQ5OTgxIiwiYXBwSWQiOiIxOjczMzY1ODQ5OTgxOndlYjpjZTE1YmYyOWEwNjNlYjFhNzhhZTE0IiwibWVhc3VyZW1lbnRJZCI6IkctUlBYRkhYVlQxWSJ9";
const firebaseConfig = JSON.parse(atob(encodedFirebaseConfig));
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db };