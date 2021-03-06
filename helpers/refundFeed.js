const commonHelper = require('./common')
const Shopify = require('shopify-api-node')
const fs = require('fs')
const Client = require('ssh2-sftp-client')
const delay = require('delay')
const TSV = require('tsv')

module.exports = {
    refundFeedInOutCreate: async (vendorInfo, connectorInfo, callback) => {
        const sftp = new Client()
        const shopify = new Shopify({
            shopName: vendorInfo.api.apiShop,
            apiKey: vendorInfo.api.apiKey,
            password: vendorInfo.api.apiPassword,
            timeout: 50000,
            autoLimit: {
                calls: 2,
                interval: 1000,
                bucketSize: 35
            }
        })
        
        sftp.connect({
            host: vendorInfo.sftp.sftpHost,
            port: process.env.SFTP_PORT,
            username: vendorInfo.sftp.sftpUsername,
            password: vendorInfo.sftp.sftpPassword
        }).then(() => {
            return sftp.list('/outgoing/returns')
        }).then(sftpFileList => {
            let fileList = []
            sftpFileList.forEach(sftpFile => {
                if (sftpFile.type == '-') {
                    fileList.push(sftpFile.name)
                }
            })
            fileList.forEach(fileName => {
                sftp.get('/outgoing/returns/' + fileName).then(fileData => {
                    var refundPost = {}, refundCalculate = {}
                    refundPost.refund_line_items = [], refundCalculate.refund_line_items = []
                    var dataFromSFTP = TSV.parse(fileData._readableState.buffer.head.data)
                    var refundData = dataFromSFTP[1], orderNumber = refundData['retailer_order_number'].split(' | ')[1]
                    var retailerOrderNumber = refundData['retailer_order_number'].split(' | ')[0]
                    var retailerRMANumber = refundData['retailer_rma_number']
                    var returnFileName = 'uploads/returns-' + vendorInfo.api.apiShop + '-' + retailerOrderNumber + '.txt'
                    
                    // Calculate refund
                    refundCalculate.currency = 'USD'
                    refundCalculate.shipping = {
                        full_refund: true
                    }
                    
                    dataFromSFTP.forEach(dataFromSFTPRow => {
                        if (dataFromSFTPRow.original_order_number != '') {
                            refundCalculate.refund_line_items.push({
                                line_item_id: dataFromSFTPRow['retailer_order_number'].split(' | ')[2],
                                quantity: dataFromSFTPRow['qty_requested'],
                                restock_type: 'return'
                            })
                        }
                    })
                    
                    shopify.refund.calculate(orderNumber, refundCalculate).then(calculateResponse => {
                        // Make refund data
                        refundPost.currency = 'USD'
                        refundPost.notify = true
                        refundPost.shipping = {
                            full_refund: true
                        }
    
                        calculateResponse.refund_line_items.forEach(calRow => {
                            refundPost.refund_line_items.push({
                                line_item_id: calRow['line_item_id'],
                                restock_type: 'return',
                                location_id: calRow['location_id'],
                                quantity: calRow['quantity']
                            })
                        })

                        refundPost.transactions = calculateResponse.transactions

                        // Create refund
                        shopify.refund.create(orderNumber, refundPost).then(createResponse => {
                            var refundInDataList = []
                            createResponse.refund_line_items.forEach((refundItem, refundIndex) => {
                                var refundInData = {}
                                refundInData.original_order_number = refundData.original_order_number
                                refundInData.rma_number = refundData.rma_number
                                refundInData.item_sku = refundItem.line_item.variant_id
                                refundInData.date_requested = commonHelper.dateStringFromString(createResponse.created_at)
                                refundInData.qty_requested = refundItem.quantity
                                refundInData.date_received = commonHelper.dateStringFromString(createResponse.processed_at)
                                refundInData.qty_received = refundItem.quantity
                                var refundReason = ''
                                createResponse.order_adjustments.forEach(orderAdjustment => {
                                    if (orderAdjustment.kind == 'refund_discrepancy') {
                                        refundReason = orderAdjustment.reason
                                    }
                                })
                                refundInData.reason = refundReason
                                refundInData.retailer_order_number = retailerOrderNumber
                                refundInData.retailer_rma_number = retailerRMANumber
                                item_status = 'Approved'

                                refundInDataList.push(refundInData)
                            })

                            sftp.delete('/outgoing/returns/' + fileName).then(result => {
                                fs.writeFile(returnFileName, TSV.stringify(refundInDataList), function (fileWriteError) {
                                    if (fileWriteError) {
                                        console.log('Writing File Error: ', fileWriteError)
                                        callback({error: 'file'})
                                    } else {
                                        var remotePath = '/incoming/returns/returns_' + commonHelper.dateStringForName() + '.txt'
                                        sftp.put(returnFileName, remotePath).then(response => {
                                            commonHelper.addStatus(vendorInfo, connectorInfo, 2, (statusErr) => {
                                                if (statusErr) {
                                                    callback({error: 'status'})
                                                } else {
                                                    callback(null, vendorInfo.name)
                                                }
                                            })
                                        }).catch(sftpUploadError => {
                                            console.log('Upload error: ', sftpUploadError)
                                            callback({error: 'upload'})
                                        })
                                    }
                                })
                            }).catch(deleteErr => {
                                console.log('Error in deleting refund file of sftp: ', deleteErr)
                                callback({error: 'delete'})
                            })
                        }).catch(createRefundError => {
                            console.log('There is a problem in creating refund: ', createRefundError)
                        })
                        
                    }).catch(calculateError => {
                        console.log('Error in calculating refund: ', calculateError)
                        commonHelper.addStatus(vendorInfo, connectorInfo, 0, (statusErr) => {
                            if (statusErr) {
                                callback('calculate and db')
                            } else {
                                callback('Calculating refund: ' + calculateError)
                            }
                        })
                    })
                }).catch(sftpError => {
                    commonHelper.addStatus(vendorInfo, connectorInfo, 0, (statusErr) => {
                        if (statusErr) {
                            callback('connect and db')
                        } else {
                            callback('Error in getting file - /outgoing/returns/' + fileName)
                        }
                    })
                })
            })
        }).catch(sftpError => {
            commonHelper.addStatus(vendorInfo, connectorInfo, 0, (statusErr) => {
                if (statusErr) {
                    callback({error: 'connect and db'})
                } else {
                    callback({error: 'connect' + ' in connecting to sftp for ' + vendorInfo.api.apiShop})
                }
            })
        })
    }
}