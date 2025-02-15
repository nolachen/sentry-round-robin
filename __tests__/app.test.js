const nock = require("nock");
const sendRequest = require("request-promise-native");
const { sentryAPIbase } = require("../constants");
const mockData = require("./mockdata.js");

jest.mock('../verify.js');

describe("app.js", () => {
  let server;
  const app = require("../app");

  const newIssueRequestOptions = {
    url: `http://127.0.0.1:${process.env.PORT}`,
    method: "POST",
    json: true,
    headers: {
      Authorization: "Bearer " + process.env.SENTRY_TOKEN,
      "Sentry-Hook-Resource": "issue"
    },
    body: mockData.newIssueRequestBody
  };

  beforeAll(async () => {
    // Mock request for fetching users that fires on server spin-up
    nock(sentryAPIbase)
      .get(
        `/organizations/${mockData.orgSlug}/users/?project=${mockData.projectID}`
      )
      .reply(200, mockData.getUsersResponse);

    app.use(function(err, req, res, next) {
      console.error(err.stack); // Explicitly output any stack trace dumps to stderr
      next(err, req, res);
    });

    server = await app.listen(process.env.PORT);
  });

  beforeEach(() => {
    app.allUsers = [...mockData.userNames];
    app.queuedUsers = [...mockData.userNames];

    // Mock request for fetching users; persist between tests
    nock(sentryAPIbase)
      .get(
        `/organizations/${mockData.orgSlug}/users/?project=${mockData.projectID}`
      )
      .reply(200, mockData.getUsersResponse);
  });

  // Reset state of user queue
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    server.close();
  });

  test("Upon receiving POST request from Sentry with new issue data, server sends reponse 200", async function() {
    // Assign issue to mock user 1
    const request = nock(sentryAPIbase)
      .put(`/issues/${mockData.issueID}/`, {
        assignedTo: mockData.userNames[0]
      })
      .reply(200, mockData.assignIssueResponse(mockData.userNames[0]));

    let result = await sendRequest(newIssueRequestOptions);
    expect(request.isDone()).toBe(true);
    expect(result).toBe("ok");
  });

  test("First user is assigned to an issue and removed from queue", async function() {
    // Start with array of user #1 and user #2
    expect(app.queuedUsers.length).toBe(2);
    expect(app.queuedUsers[0]).toBe(mockData.userNames[0]);

    // Assign issue to mock user 1
    const request = nock(sentryAPIbase)
      .put(`/issues/${mockData.issueID}/`, {
        assignedTo: mockData.userNames[0]
      })
      .reply(200, mockData.assignIssueResponse(mockData.userNames[0]));

    await sendRequest(newIssueRequestOptions);
    expect(request.isDone()).toBe(true);

    // Expect user #1 to be removed, so user at index 0 is now user #2
    expect(app.queuedUsers.length).toBe(1);
    expect(app.queuedUsers[0]).toBe(mockData.userNames[1]);
  });

  test("When all users in queue are assigned an issue, queue is reset", async function() {
    const request1 = nock(sentryAPIbase)
      .put(`/issues/${mockData.issueID}/`, {
        assignedTo: mockData.userNames[0]
      })
      .reply(200, mockData.assignIssueResponse(mockData.userNames[0]));

    const request2 = nock(sentryAPIbase)
      .put(`/issues/${mockData.issueID}/`, {
        assignedTo: mockData.userNames[1]
      })
      .reply(200, mockData.assignIssueResponse(mockData.userNames[1]));

    // Assign both mock users to issues, removing them form users queue
    await sendRequest(newIssueRequestOptions);
    expect(request1.isDone()).toBe(true);

    await sendRequest(newIssueRequestOptions);
    expect(request2.isDone()).toBe(true);

    // Expect queue to be empty
    expect(app.queuedUsers.length).toBe(0);

    // Assign a third mock  user, prompting queue to be reset
    const request3 = nock(sentryAPIbase)
      .put(`/issues/${mockData.issueID}/`, {
        assignedTo: mockData.userNames[0]
      })
      .reply(200, mockData.assignIssueResponse(mockData.userNames[0]));

    await sendRequest(newIssueRequestOptions);
    expect(request3.isDone()).toBe(true);

    // User #1 immediately assigned and removed from queue,
    // so user at index 0 is now user #2
    expect(app.queuedUsers.length).toBe(1);
    expect(app.queuedUsers[0]).toBe(mockData.userNames[1]);
  });

  test("When a user no longer exists, reassign to subsequent users until successful", async function() {
    // Response for non-existent user
    const request1 = nock(sentryAPIbase)
      .put(`/issues/${mockData.issueID}/`, { assignedTo: mockData.fakeUser })
      .reply(400, mockData.getFakeUserResponse);

    // Response for second (valid) user
    const request2 = nock(sentryAPIbase)
      .put(`/issues/${mockData.issueID}/`, {
        assignedTo: mockData.userNames[1]
      })
      .reply(200, mockData.assignIssueResponse(mockData.userNames[1]));

    // Override with mock user that doesn't exist in the mock API
    app.allUsers[0] = mockData.fakeUser;
    app.queuedUsers[0] = mockData.fakeUser;

    // Assign both mock users to issues, removing them form users queue
    await sendRequest(newIssueRequestOptions);
    expect(request1.isDone()).toBe(true); // 400
    expect(request2.isDone()).toBe(true); // 200 (success)

    // Expect queue to be empty after removing nonexistent user #1
    // and then assigning/removing user #2
    expect(app.queuedUsers.length).toBe(0);
  });

  // TODO: How to test this?
  test.skip("Upon assigning an issue when no valid users are remaining in allUsers queue, throw error (kill the server)", async function() {
    // Override with empty users queue
    app.allUsers = [];
    app.queuedUsers = [];

    // Response for second (valid) user
    const request = nock(sentryAPIbase)
      .put(`/issues/${mockData.issueID}/`, {
        assignedTo: mockData.userNames[0]
      })
      .reply(200, mockData.assignIssueResponse(mockData.userNames[0]));

    // Create mocked new issue, triggering update of user queue
    await expect(sendRequest(newIssueRequestOptions)).rejects.toThrow();
    // NOTE: ^ doesn't work of course
  });

  describe("no-ops", function () {
    let request;
    beforeEach(function () {
      // Assign issue to mock user 1
      request = nock(sentryAPIbase)
        .put(`/issues/${mockData.issueID}/`)
        .query(true)
        .replyWithError('should never be called')
    });

    it("Should ignore webhook requests for non-issue resources", async function () {
      let result = await sendRequest({
        url: `http://127.0.0.1:${process.env.PORT}`,
        method: "POST",
        json: true,
        headers: {
          Authorization: "Bearer " + process.env.SENTRY_TOKEN,
          "Sentry-Hook-Resource": "event"
        },
        body:{}
      });
      expect(result).toBe("ok");
      expect(request.isDone()).toBe(false); // API never called
    });

    it("Should ignore webhook requests for issue resources that are not 'created' actions", async function () {
      let result = await sendRequest({
        url: `http://127.0.0.1:${process.env.PORT}`,
        method: "POST",
        json: true,
        headers: {
          Authorization: "Bearer " + process.env.SENTRY_TOKEN,
          "Sentry-Hook-Resource": "issue"
        },
        body:{ action: "deleted" }
      });
      expect(result).toBe("ok");
      expect(request.isDone()).toBe(false); // API never called
    });
  });
});
