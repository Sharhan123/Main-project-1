const express = require('express');
const router = express.Router();
const userdatacopy = require('../model/schema')
const bycrypt = require('bcrypt')
const nodemailer = require('nodemailer');
const useraddresscopy = require('../model/address')
const products = require('../model/product');
const cartModel = require('../model/cart');
const Orders = require('../model/orders');
const catagory = require('../model/catagory')
const helper = require('../helpers/paymenthelper')
const Razorpay = require('razorpay');
const crypto = require('crypto');


const { errorMonitor } = require('nodemailer/lib/xoauth2');
const ban = require('../model/banner');

var instance = new Razorpay({
    key_id: 'rzp_test_f0CUyOMdkz5Ems',
    key_secret: 'jVlliMIYj9LGEaoxylbCt0j1',
});


const saveorder = async function (req, res) {
    try {
        console.log(req.body);
        let orderid
        let date = new Date()
        let payment = req.body.payment
        let userId
        if (req.cookies.user) {
            userId = req.cookies.user.id;
        }

        const user = await userdatacopy.findById(userId);

        if (!user) {
            return res.status(400).json({ message: 'User not found' });
        }

        const productId = req.body.productId;
        let productDetails;
        let orderItems;
        if (typeof productId === 'string') {
            productDetails = await products.findById(productId);
            if (!productDetails) {
                return res.status(400).json({ message: 'Product not found for ID: ' + productId });
            }
            orderItems = [{
                Payment: payment,
                Productid: productDetails._id,
                Productname: productDetails.Productname,
                Productimg: productDetails.Imagepath[0],
                Price: productDetails.Price - productDetails.Discount,
                Quantity: req.body.quantity
            }];

        } else if (Array.isArray(productId)) {


            productDetails = await products.find({ _id: { $in: productId } });
            if (!productDetails) {
                return res.status(400).json({ message: 'Products not found for the given IDs' });
            }
            orderItems = productDetails.map((product, index) => {
                return {
                    Payment: payment,
                    Productid: product._id,
                    Productname: product.Productname,
                    Productimg: product.Imagepath[0],
                    Price: product.Price - product.Discount,
                    Quantity: req.body.quantity[index],
                };
            });
        } else {

            return res.status(400).json({ message: 'Invalid product ID(s) provided' });

        }

        const deliveryAddress = {
            cname: req.body.uname,
            country: req.body.country,
            state: req.body.state,
            city: req.body.city,
            pincode: req.body.pincode,
            streetaddress: req.body.streetaddress1[0],
            landmark: req.body.streetaddress1[1],
        };





        const totalAmount = orderItems.reduce((total, item) => total + item.Price * item.Quantity, 0);

        const orderData = {
            Userid: user._id,
            Username: user.username,
            Shippingcost: 0,
            Status: 'pending',
            Items: orderItems,
            Deliveryaddress: deliveryAddress,
            Totalamount: totalAmount,
            Orderdate: date,
        };

        await Orders.create(orderData).then((data) => {
            console.log("saved" + data);
        });

        orderid = await Orders.findOne({ Orderdate: date })




        if (payment === 'pod') {
            console.log("Entered");
            await Orders.updateOne({ Orderdate: date }, { $set: { Status: 'active' } })
            helper.generateRazorpay(orderid._id, totalAmount).then((response) => {
                console.log(response);
                res.json(response);
            })



        } else if (payment === 'cod') {
            await Orders.updateOne({ Orderdate: date }, { $set: { Status: 'active' } })
            res.json({ codsuccess: true })
        }



    } catch (err) {
        console.error(err);
    }
}


const placeorder = async function (req, res, next) {
    userid = req.cookies.user.id
    let array= []
    const name = req.cookies.user.id

    const address = await Orders.findOne({ Userid: name })
    const cart = await cartModel.findOne({ Userid: userid });
     cart.Products.forEach(element => {
        array.push(element.Productid)
    });
    
    await products.updateMany({ _id: { $in: array } },{$inc:{soldcount:+1}})
    cart.Products = []

    await cart.save();

    res.render('user/placeorder', { address })
}

const removeorder = async function (req, res,) {
    try {
        const orderId = req.params.id;
        const Ordersid = req.params.oid;
        console.log("orderid : " + orderId, "userid : " + Ordersid);

        // Find the order and update the Items array
        const order = await Orders.findById(Ordersid);

        // Filter out the item with the given _id
        const index = order.Items.findIndex((item) => item._id == orderId);
        order.Totalamount = order.Totalamount - order.Items[index].Price;

        order.Items = order.Items.filter(
            (item) => item._id.toString() !== orderId
        );

        if (order.Items.length < 1) {
            await Orders.findByIdAndRemove(Ordersid);
        }
        // Save the updated order
        await order.save();

        res.redirect('/dash')
    } catch (error) {
        console.error("Error removing item:", error);
        res.status(500).send("Internal Server Error");
    }

}


const verifyPayment = async (req, res) => {
    try {
        console.log();
        const cartData = await cartModel.findOne({ Userid: req.cookies.user.id });
        const product = cartData.Products;
        const details = req.body;

        const hmac = crypto.createHmac("sha256", 'jVlliMIYj9LGEaoxylbCt0j1');
        console.log(details['order[receipt]']);

        hmac.update(
            details['payment[razorpay_order_id]'] +
            "|" +
            details['payment[razorpay_payment_id]']
        );

        const hmacValue = hmac.digest("hex");

        if (hmacValue === details['payment[razorpay_signature]']) {
            for (let i = 0; i < product.length; i++) {
                const pro = product[i].Productid;
                const count = product[i].Quantity;
                await products.updateOne(
                    { _id: pro },
                    { $inc: { Stoke: -count } }
                );
            }

            await Orders.updateOne(
                { _id: details['order[receipt]'] },
                { $set: { Status: 'active' } }
            );

            await Orders.findByIdAndUpdate(
                { _id: details['order[receipt]'] },
                {
                    $set: { paymentId: details['payment[razorpay_payment_id]'] }
                });

            const orderid = details['order[receipt]'];

            res.json({ codsuccess: true, orderid });
        } else {
            await Orders.findByIdAndRemove({ _id: details['order[receipt]'] });
            res.json({ success: false });
        }
    } catch (error) {
        console.log(error.message);
    }
};


const vieworder = async function (req, res, next) {
    try {
        let id = req.query.id

        const order = await Orders.findOne({ _id: id });
        console.log("order", order);
        res.render('user/vieworder', { order: order })




    } catch (err) {
        console.log(err);
    }
}


const cancelorder = async function (req, res, next) {
    try {

        let order = req.params.id

        await Orders.findOneAndUpdate({ _id: order }, { $set: { Status: 'Cancelled' } })
        next()
    } catch (err) {
        console.log(err);
    }
}


module.exports = {
    saveorder,
    placeorder,
    removeorder,
    verifyPayment,
    vieworder,
    cancelorder
}