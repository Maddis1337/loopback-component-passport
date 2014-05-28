var loopback = require('loopback');
var passport = require('passport');
var models = require('./models/user-identity');

module.exports = PassportConfigurator;

/**
 * The passport configurator
 * @param {Object} app The LoopBack app instance
 * @returns {PassportConfigurator}
 * @constructor
 * @class
 */
function PassportConfigurator(app) {
  if (!(this instanceof PassportConfigurator)) {
    return new PassportConfigurator(app);
  }
  this.app = app;
}

/**
 * Set up data models for user identity/credential and application credential
 * @options {Object} options Options for models
 * @property {Model} [userModel] The user model class
 * @property {Model} [userCredentialModel] The user credential model class
 * @property {Model} [userIdentityModel] The user identity model class
 * @end
 */
PassportConfigurator.prototype.setupModels = function (options) {
  options = options || {};
  // Set up relations
  this.userModel = options.userModel || loopback.getModelByType(loopback.User);
  this.userCredentialModel = options.userCredentialModel || loopback.getModelByType(models.UserCredential);
  this.userIdentityModel = options.userIdentityModel || loopback.getModelByType(models.UserIdentity);

  if (!this.userModel.relations.identities) {
    this.userModel.hasMany(this.userIdentityModel, {as: 'identities'});
  } else {
    this.userIdentityModel = this.userModel.relations.identities.modelTo;
  }

  if (!this.userModel.relations.credentials) {
    this.userModel.hasMany(this.userCredentialModel, {as: 'credentials'});
  } else {
    this.userCredentialModel = this.userModel.relations.credentials.modelTo;
  }
}

/**
 * Initialize the passport configurator
 * @param {Boolean} noSession Set to true if no session is required
 */
PassportConfigurator.prototype.init = function (noSession) {
  var self = this;
  self.app.use(passport.initialize());

  if (!noSession) {
    self.app.use(passport.session());

    // Serialization and deserialization is only required if passport session is
    // enabled

    passport.serializeUser(function (user, done) {
      done(null, user.id);
    });

    passport.deserializeUser(function (id, done) {

      // Look up the user instance by id
      self.userModel.findById(id, function (err, user) {
        if (err || !user) {
          return done(err, user);
        }
        user.identities(function (err, identities) {
          user.profiles = identities;
          user.credentials(function (err, accounts) {
            user.accounts = accounts;
            done(err, user);
          });
        });
      });
    });
  }
}

/**
 * Configure a passport strategy provider
 * @param {String} name The provider name
 * @options options Options for the provider. It depends on the auth scheme.
 * @property {Boolean} link Set to true if the provider is for third party account linking
 * @property {Object} module The passport strategy module from require
 * @property {String} authScheme The authentication scheme, such as 'local', 'oAuth 2.0'
 * @property {String} [clientID] oAuth 2.0 client id
 * @property {String} [clientSecret] oAuth 2.0 client secret
 * @property {String} [callbackURL} oAuth 2.0 callback URL
 * @property {String} [authPath] Authentication route
 * @property {String} [callbackPath] oAuth 2.0 callback route
 * @property {String} [successRedirect] The redirect route if login succeeds
 * @property {String} [failureRedirect] The redirect route if login fails
 * @property {String} [scope] oAuth 2.0 scopes
 * @property {Boolean} [session] Set to true if session is required
 * @property {String} [usernameField] The field name for username on the form for local strategy
 * @property {String} [passwordField] The field name for password on the form for local strategy
 * @property {String} [consumerKey] oAuth 1 consumer key
 * @property {String} [consumerSecret] oAuth 1 consumer secret
 * @property {String} [returnURL] OpenID return URL
 * @property {String} [realm] OpenID realm,
 * @end
 */
PassportConfigurator.prototype.configureProvider = function (name, options) {
  var self = this;
  options = options || {};
  var link = options.link;
  var AuthStrategy = require(options.module)[options.strategy || 'Strategy'];

  var authScheme = options.authScheme || 'oAuth 2.0';
  var clientID = options.clientID;
  var clientSecret = options.clientSecret;
  var callbackURL = options.callbackURL;
  var authPath = options.authPath || ((link ? '/link/' : '/auth/') + name);
  var callbackPath = options.callbackPath || ((link ? '/link/' : '/auth/') + name + '/callback');
  var successRedirect = options.successRedirect || (link ? '/link/account' : '/auth/account');
  var failureRedirect = options.failureRedirect || (link ? '/link.html' : '/login.html');
  var scope = options.scope;

  var session = !!options.session;

  function loginCallback(req, done) {
    return function (err, user, identity, token) {
      var authInfo = {
        identity: identity
      };
      if (token) {
        authInfo.accessToken = token;
      }
      done(err, user, authInfo);
    };
  }

  switch (authScheme.toLowerCase()) {
    case 'local':
      passport.use(name, new AuthStrategy({
          usernameField: options.usernameField || 'username',
          passwordField: options.passwordField || 'password',
          session: options.session
        },
        function (username, password, done) {
          var query = {where: {or: [
            {username: username},
            {email: username}
          ]}};
          self.userModel.findOne(query, function (err, user) {
            if (err) {
              return done(err);
            }
            if (user) {
              user.hasPassword(password, function (err, ok) {
                if (ok) {
                  var u = user.toJSON();
                  delete u.password;
                  var userProfile = {
                    provider: 'local',
                    id: u.id,
                    username: u.username,
                    emails: [
                      {
                        value: u.email
                      }
                    ],
                    status: u.status
                  };
                  done(null, userProfile);

                } else {
                  return done(null, false, { message: 'Incorrect password.' });
                }
              });
            } else {
              return done(null, false, { message: 'Incorrect username.' });
            }
          });
        }
      ));
      break;
    case 'oauth':
    case 'oauth1':
    case 'oauth 1.0':
      passport.use(name, new AuthStrategy({
          consumerKey: options.consumerKey,
          consumerSecret: options.consumerSecret,
          callbackURL: callbackURL,
          passReqToCallback: true
        },
        function (req, token, tokenSecret, profile, done) {
          if (link) {
            if (req.user) {
              self.userCredentialModel.link(req.user.id, name, authScheme, profile,
                {token: token, tokenSecret: tokenSecret}, options, done);
            } else {
              done('No user is logged in');
            }
          } else {
            self.userIdentityModel.login(name, authScheme, profile,
              {token: token, tokenSecret: tokenSecret}, options, loginCallback(req, done));
          }
        }
      ));
      break;
    case 'openid':
      passport.use(name, new AuthStrategy({
          returnURL: options.returnURL,
          realm: options.realm,
          callbackURL: callbackURL,
          passReqToCallback: true
        },
        function (req, identifier, profile, done) {
          if (link) {
            if (req.user) {
              self.userCredentialModel.link(req.user.id, name, authScheme, profile,
                {identifier: identifier}, options, done);
            } else {
              done('No user is logged in');
            }
          } else {
            self.userIdentityModel.login(name, authScheme, profile,
              {identifier: identifier}, options, loginCallback(req, done));
          }
        }
      ));
      break;
    case 'openid connect':
      passport.use(name, new AuthStrategy({
          clientID: clientID,
          clientSecret: clientSecret,
          callbackURL: callbackURL,
          passReqToCallback: true
        },
        function (req, accessToken, refreshToken, profile, done) {
          if (link) {
            if (req.user) {
              self.userCredentialModel.link(req.user.id, name, authScheme, profile,
                {accessToken: accessToken, refreshToken: refreshToken}, options, done);
            } else {
              done('No user is logged in');
            }
          } else {
            self.userIdentityModel.login(name, authScheme, profile,
              {accessToken: accessToken, refreshToken: refreshToken},
              options, loginCallback(req, done));
          }
        }
      ));
      break;
    default:
      passport.use(name, new AuthStrategy({
          clientID: clientID,
          clientSecret: clientSecret,
          callbackURL: callbackURL,
          passReqToCallback: true
        },
        function (req, accessToken, refreshToken, profile, done) {
          if (link) {
            if (req.user) {
              self.userCredentialModel.link(req.user.id, name, authScheme, profile,
                {accessToken: accessToken, refreshToken: refreshToken}, options, done);
            } else {
              done('No user is logged in');
            }
          } else {
            self.userIdentityModel.login(name, authScheme, profile,
              {accessToken: accessToken, refreshToken: refreshToken},
              options, loginCallback(req, done));
          }
        }
      ));
  }

  /*
   * Redirect the user to Facebook for authentication.  When complete,
   * Facebook will redirect the user back to the application at
   * /auth/facebook/callback with the authorization code
   */
  if (link) {
    self.app.get(authPath, passport.authorize(name, {scope: scope, session: session}));
  } else {
    self.app.get(authPath, passport.authenticate(name, {scope: scope, session: session}));
  }

  /*
   * Facebook will redirect the user to this URL after approval. Finish the
   * authentication process by attempting to obtain an access token using the
   * authorization code. If access was granted, the user will be logged in.
   * Otherwise, authentication has failed.
   */
  if (link) {
    self.app.get(callbackPath, passport.authorize(name, {
        session: session,
        // successReturnToOrRedirect: successRedirect,
        successRedirect: successRedirect,
        failureRedirect: failureRedirect }),
      // passport.authorize doesn't handle redirect
      function (req, res, next) {
        res.redirect(successRedirect);
      }, function (err, req, res, next) {
        res.redirect(failureRedirect);
      });
  } else {
    self.app.get(callbackPath, function (req, res, next) {
      var customCallback = options.customCallback || function (err, user, info) {
        if (err) {
          return next(err);
        }
        if (!user) {
          return res.redirect(failureRedirect);
        }
        req.logIn(user, function (err) {
          if (err) {
            return next(err);
          }
          if (info && info.accessToken) {
            res.cookie('access-token', info.accessToken.id, { signed: true,
              maxAge: info.accessToken.ttl });
          }
          return res.redirect(successRedirect);
        });
      };
      passport.authenticate(name, {session: session}, customCallback)(req, res, next);
    });
  }
}