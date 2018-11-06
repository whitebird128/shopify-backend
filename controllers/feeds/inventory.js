const Shopify = require('shopify-api-node');
const fs = require('fs');
const Client = require('ssh2-sftp-client');
const delay = require('delay');
const TSV = require('tsv');

const Vendor = require('../../models/Vendor');

/**
 * GET /
 * Inventory page.
 */
exports.index = async (req, res, next) => {

    var vendorData;
    var shopify;
    Vendor.findOne({_id: req.user.vendorId}, (vendorError, vendor) => {
        if (vendorError) {
            return next(vendorError);
        }
        vendorData = vendor;
        
        if (vendorData.api.apiShop == '' || vendorData.api.apiKey == '' || vendorData.api.apiPassword == '') {
            req.flash('info', {
                msg: 'You should have API information to manage product feed. Please contact with Administrator.'
            });
            res.redirect('/');
            return next();
        }
        if (vendorData.sftp.sftpHost == '' || vendorData.sftp.sftpPassword == '' || vendorData.sftp.sftpUsername == '') {
            req.flash('info', {
                msg: 'You should have SFTP information to manage product feed. Please contact with Administrator.'
            });
            res.redirect('/');
            return next();
        }
        shopify = new Shopify({
            shopName: vendorData.api.apiShop,
            apiKey: vendorData.api.apiKey,
            password: vendorData.api.apiPassword
        });
    });

    await delay(1000);
    const sftp = new Client();
    var inventoryDataList = new Array();

    deleteAndInitialize('uploads/inventory.txt');

    shopify.collect.list()
        .then(collects => {
            collects.forEach(collect => {
                shopify.product.get(collect.product_id)
                    .then(product => {
                        product.variants.forEach(variant => {
                            var inventoryData = {};
                            inventoryData.id = variant.id;
                            inventoryData.qty_on_hand = variant.inventory_quantity < 0 ? 0 : variant.inventory_quantity;
                            inventoryData.date_available = product.published_at;

                            inventoryDataList.push(inventoryData);
                        });
                    })
                    .catch(inventoryError => console.log('inventoryError: ', inventoryError));

            });
        })
        .then(async () => {
            await delay(1000);
            sftp.connect({
                    host: vendorData.sftp.sftpHost,
                    port: process.env.SFTP_PORT,
                    username: vendorData.sftp.sftpUsername,
                    password: vendorData.sftp.sftpPassword
                })
                .then(async () => {
                    await delay(1000);
                    fs.writeFile("uploads/inventory.txt", TSV.stringify(inventoryDataList), function (err) {
                        if (err) {
                            console.log('Writing File Error: ', err);
                        } else {
                            var currentDate = new Date();
                            var temp = currentDate.toLocaleString("en-US", {hour12: false}).split('.');
                            var remotePath = '/incoming/inventory/inventory' + temp[0].replace(' ', '').replace(/\-/g, '').replace(/\:/g, '').replace(/\//g, '').replace(',', '') + '.txt';
                            sftp.put('uploads/inventory.txt', remotePath)
                                .then(response => {
                                    res.render('feeds/inventory', {
                                        title: 'Inventory',
                                        inventoryList: inventoryDataList
                                    });
                                })
                                .catch(error => console.log('upload error: ', error));
                        }
                    });
                })
                .catch(error => console.log('connect error: ', error));
        })
        .catch(err => console.log('collectError: ', err));

};

const deleteAndInitialize = function (filePath) {
    if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) throw err;
            console.log(filePath + ' file was deleted');
            fs.writeFile(filePath, '', function (initErr) {
                if (initErr) {
                    console.log(initErr);
                }
                console.log('init empty');
            });
        });
    }
}