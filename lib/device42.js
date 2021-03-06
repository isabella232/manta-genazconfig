/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * lib/device42.js: provides low-level interfaces for fetching data from a
 * Device42 instance
 */

var mod_assertplus = require('assert-plus');
var mod_https = require('https');
var mod_jsprim = require('jsprim');
var mod_lomstream = require('lomstream');
var mod_querystring = require('querystring');
var mod_stream = require('stream');
var mod_url = require('url');
var VError = require('verror');

/* Exported interface */
exports.d42FetchRawDeviceDetails = d42FetchRawDeviceDetails;
exports.D42Device = D42Device;

/*
 * Convenience function for fetching detailed device information.
 */
function d42FetchRawDeviceDetails(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.url, 'args.url');
	mod_assertplus.string(args.username, 'args.username');
	mod_assertplus.string(args.password, 'args.password');
	mod_assertplus.object(args.queryparams, 'args.queryparams');

	return (d42FetchStream({
	    'url': args.url,
	    'username': args.username,
	    'password': args.password,
	    'queryparams': args.queryparams,
	    'resource': '/api/1.0/devices/all/',
	    'limit': 100
	}));
}

/*
 * General-purpose function for listing objects from Device42.  Named arguments:
 *
 *     url		HTTPS URL for the Device42 endpoint.  This should not
 *     			include a username or a resource (other than "/")
 *
 *     username		username to use for HTTP basic authentication
 *
 *     password		password to use for HTTP basic authentication
 *
 *     resource		API resource to fetch
 *
 *     queryparams	query parameters (as an object of key-value pairs)
 *
 *     limit		integer number of objects to fetch with each request
 *
 * This returns an object-mode stream that emits all of the objects to be
 * listed.  This makes multiple requests of size "limit" as needed to list all
 * of the objects.
 */
function d42FetchStream(args)
{
	var u, err, auth, resource, stream;

	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.url, 'args.url');
	mod_assertplus.string(args.username, 'args.username');
	mod_assertplus.string(args.password, 'args.password');
	mod_assertplus.string(args.resource, 'args.resource');
	mod_assertplus.object(args.queryparams, 'args.queryparams');
	mod_assertplus.number(args.limit, 'args.limit');

	u = mod_url.parse(args.url);
	if (u.protocol != 'https:') {
		err = new VError(
		    'Device42 URL: only "https" URLs are supported');
	} else if (u.path != '/') {
		err = new VError('Device42 URL: trailing characters');
	} else if (u.auth !== null) {
		err = new VError('Device42 URL: username and password ' +
		    'may not be specified directly in the URL');
	} else if (args.username.indexOf(':') != -1) {
		err = new VError('Device42 username may not contain a colon');
	}

	if (err) {
		stream = new mod_stream.PassThrough();
		setImmediate(function emitError() {
			stream.emit('error', err);
		});
		return (stream);
	}

	auth = args.username + ':' + args.password;
	resource = args.resource;
	stream = new mod_lomstream.LOMStream({
	    'limit': args.limit,
	    'offset': true,
	    'fetch': function d42LomFetch(_1, lim, _2, resultfunc) {
		var qparams, rqargs, request;

		mod_assertplus.number(lim.offset);
		mod_assertplus.number(lim.limit);

		qparams = mod_jsprim.deepCopy(args.queryparams);
		qparams['offset'] = lim.offset;
		qparams['limit'] = lim.limit;
		rqargs = {
		    'hostname': u['hostname'],
		    'port': u['port'],
		    'path': resource + '?' + mod_querystring.stringify(qparams),
		    'auth': auth
		};
		request = mod_https.get(rqargs);

		request.on('response', function (response) {
			var d, parsed;

			/*
			 * We don't currently handle redirects, but we also
			 * should not get them because we include trailing
			 * slashes on our URLs.
			 */
			if (response.statusCode >= 300) {
				/*
				 * Read the rest of the response to finish
				 * cleanup.
				 */
				response.resume();
				resultfunc(new VError(
				    'unexpected response code "%s"',
				    response.statusCode));
				return;
			}

			/*
			 * We should have a limit on how much data we read.
			 */
			d = '';
			response.on('data', function (chunk) {
				d += chunk.toString('utf8');
			});
			response.on('end', function () {
				try {
					parsed = JSON.parse(d);
				} catch (ex) {
					resultfunc(new VError(ex,
					    'failed to parse Device42 ' +
					    'response'));
					return;
				}

				if (parsed.total_count === 0) {
					resultfunc(null, {
					    'done': true,
					    'results': []
					});
					return;
				}

				/*
				 * XXX validate with a schema
				 */
				mod_assertplus.number(parsed.total_count);
				mod_assertplus.number(parsed.limit);
				mod_assertplus.number(parsed.offset);
				mod_assertplus.arrayOfObject(parsed.Devices);

				resultfunc(null, {
				    'done': parsed.offset + parsed.limit >=
				        parsed.total_count,
				    'results': parsed.Devices
				});
			});

		});
	    }
	});

	return (stream);
}

/*
 * Class used as a struct to represent Devices from Device42.  See the schema in
 * lib/schema.js.
 */
function D42Device(raw)
{
	mod_assertplus.object(raw, 'raw');
	mod_assertplus.number(raw.device_id, 'raw.device_id');
	mod_assertplus.string(raw.serial_no, 'raw.serial_no');
	mod_assertplus.string(raw.name, 'raw.name');
	mod_assertplus.optionalString(raw.uuid, 'raw.uuid');
	mod_assertplus.optionalString(raw.hw_model, 'raw.hw_model');
	mod_assertplus.optionalNumber(raw.ram, 'raw.ram');
	mod_assertplus.optionalString(raw.building, 'raw.building');
	mod_assertplus.optionalString(raw.rack, 'raw.rack');
	mod_assertplus.optionalNumber(raw.start_at, 'raw.start_at');

	this.d42d_devid = raw.device_id;
	this.d42d_name = raw.name;
	this.d42d_serial = raw.serial_no;
	this.d42d_hardware = raw.hw_model || null;
	this.d42d_building = raw.building || null;
	this.d42d_rack = raw.rack || null;
	this.d42d_start = raw.start_at || null;
	this.d42d_uuid = raw.uuid || null;
	this.d42d_ramgb = typeof (raw.ram) == 'number' ?
	    Math.round(raw.ram / 1024) : null;
}
